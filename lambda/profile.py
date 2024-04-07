import os
import re
import json
import boto3
import secrets
import logging
from datetime import datetime, timedelta, timezone
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

def change_email(event):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check required parameters
    body = json.loads(event['body'])

    if 'email' not in body:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    # Get variables
    username = event['requestContext']['authorizer']['lambda']['username']
    email = body['email']

    # Check email format
    email_regex = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b'
    if not re.fullmatch(email_regex, email):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The new email is not a valid email."})
        }

    # Check if the email already exists
    response = dynamodb.query(
        TableName='retrox-users',
        IndexName='email-index',
        KeyConditionExpression='email = :email',
        ExpressionAttributeValues={
            ':email': {'S': email}
        }
    )
    if response['Count'] != 0:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This email already exists."})
        }

    # Generate verify code
    verify_code = secrets.token_urlsafe(32)

    # Assign verify code to user
    try:
        dynamodb.update_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ExpressionAttributeNames={
                '#verify_code': 'verify_code',
                '#verify_code_ttl': 'verify_code_ttl',
                '#new_email': 'new_email',
            },
            ExpressionAttributeValues={
                ':verify_code': {
                    'S': verify_code,
                },
                ':verify_code_ttl': {
                    'N': str(int((datetime.now(tz=timezone.utc) + timedelta(days=1)).timestamp())),
                },
                ':new_email': {
                    'S': email,
                },
            },
            UpdateExpression='SET #verify_code = :verify_code, #verify_code_ttl = :verify_code_ttl, #new_email = :new_email',
            ConditionExpression='attribute_exists(username)',
        )
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account no longer exists."})
        }
    except Exception as e:
        logger.error(str(e))
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "An error occurred retrieving the account. Please try again in a few minutes."})
        }

    # Build Verify URL
    verify_url = f"https://www.retrox.app/verify.html?username={username}&code={verify_code}&origin=profile"

    # Get the Verify email template
    with open("verify_email.html", "r") as fopen:
        HTML_EMAIL_CONTENT = fopen.read().replace('{URL}', verify_url)

    # Send Verify email
    try:
        ses = boto3.client('ses')
        request = ses.send_email(
            Source="RetroX Emulator <no-reply@retrox.app>",
            Destination={
                "ToAddresses": [ email ],
            },
            Message={
                "Subject": {
                    "Data": "Verify email address",
                    "Charset": "UTF-8",
                },
                "Body": {
                    "Html": {
                        "Data": HTML_EMAIL_CONTENT,
                        "Charset": "UTF-8",
                    }
                },
            },
        )
    except Exception:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "An error occurred sending the verify email. Please register again in a few minutes."})
        }

    # Return success
    return {
        'statusCode': 200,
        'body': json.dumps({"message": "Check your mail to verify this new email."})
    }

def change_password(event):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check required parameters
    body = json.loads(event['body'])

    if 'password' not in body:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    # Get variables
    username = event['requestContext']['authorizer']['lambda']['username']
    password = body['password']

    # Check password requirements
    if len(password) < 8:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The password must contain at least 8 characters."})
        }

    # Encrypt password
    f = Fernet(os.environ['SECRET_KEY'].encode())
    password_encrypted = f.encrypt(password.encode()).decode()

    # Assign new password to user
    try:
        dynamodb.update_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ExpressionAttributeNames={
                '#password': 'password',
            },
            ExpressionAttributeValues={
                ':password': {
                    'S': password_encrypted,
                },
            },
            UpdateExpression='SET #password = :password',
            ConditionExpression='attribute_exists(username)',
        )
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account no longer exists."})
        }
    except Exception as e:
        logger.error(str(e))
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "An error occurred retrieving the account. Please try again in a few minutes."})
        }

    return {
        'statusCode': 200,
        'body': json.dumps({"message": "Password changed."})
    }


def change_google_drive_api(event):
    pass

def change_two_factor(event):
    pass

def delete_account(event):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Get variables
    username = event['requestContext']['authorizer']['lambda']['username']

    # Delete account
    try:
        dynamodb.delete_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ConditionExpression='attribute_exists(username)',
        )
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account no longer exists."})
        }
    except Exception as e:
        logger.error(str(e))
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "An error occurred retrieving the account. Please try again in a few minutes."})
        }

    return {
        'statusCode': 200,
        'body': json.dumps({"message": "Account deleted."})
    }

def lambda_handler(event, context):
    if event['requestContext']['http']['path'] == '/profile/email':
        return change_email(event)
    elif event['requestContext']['http']['path'] == '/profile/password':
        return change_password(event)
    elif event['requestContext']['http']['path'] == '/profile/google':
        return change_google_drive_api(event)
    elif event['requestContext']['http']['path'] == '/profile/twofactor':
        return change_two_factor(event)
    elif event['requestContext']['http']['path'] == '/profile/delete':
        return delete_account(event)

    return {
        'statusCode': 400,
        'body': json.dumps({"message": "Invalid method."})
    }
