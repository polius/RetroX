import os
import json
import boto3
import logging
import requests
import secrets
from datetime import datetime, timedelta, timezone
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

def request(body):
    if not {'email','username','turnstile'}.issubset(body.keys()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The username and email are required."})
        }

    # Get variables
    email = body['email']
    username = body['username']
    secret_key = os.environ['SECRET_KEY']

    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Get DynamoDB user
    response = dynamodb.get_item(
        TableName='retrox-users',
        Key={'username': {'S': username}},
        ProjectionExpression='email, recover_code_time',
    )
    user = response.get('Item')

    # Check if user is not yet verified
    if not user or user['email']['S'] != email:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account does not exist."})
        }

    # Check recover_code_time
    if 'recover_code_time' in user and int(user['recover_code_time']['N']) > int((datetime.now(tz=timezone.utc) - timedelta(minutes=1)).timestamp()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Wait one minute before trying again."})
        }

    # Generate recover code
    recover_code = secrets.token_urlsafe(32)

    # Update recover_code DynamoDB
    try:
        dynamodb.update_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ExpressionAttributeNames={
                '#recover_code': 'recover_code',
                '#recover_code_time' : 'recover_code_time',
            },
            ExpressionAttributeValues={
                ':recover_code': {
                    'S': recover_code
                },
                ':recover_code_time': {
                    'N': str(int(datetime.now(tz=timezone.utc).timestamp())),
                },
            },
            UpdateExpression='SET #recover_code = :recover_code, #recover_code_time = :recover_code_time',
            ConditionExpression='attribute_exists(username)',
        )
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account does not exist."})
        }
    except Exception as e:
        logger.error(str(e))
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "An error occurred retrieving the account. Please try again in a few minutes."})
        }

    # Build Verify URL
    verify_url = f"https://www.retrox.app/recover.html?username={username}&code={recover_code}"

    # Get the Verify email template
    with open("recover_account.html", "r") as fopen:
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
                    "Data": "Recover account",
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
        'body': json.dumps({"message": "The recover account email has been sent."})
    }

def submit(body):
    if not {'username','code','turnstile'}.issubset(body.keys()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid URL."})
        }

    # Get variables
    username = body['username']
    code = body['code']
    secret_key = os.environ['SECRET_KEY']

    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check recover_code validity
    response = dynamodb.get_item(
        TableName='retrox-users',
        Key={'username': {'S': username}},
        ProjectionExpression='recover_code, recover_code_time',
    )
    user = response.get('Item')

    # Check request validity
    if not user or 'recover_code' not in user or user['recover_code']['S'] != code:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid URL."})
        }

    # Check code expiration
    if int(user['recover_code_time']['N']) < int((datetime.now(tz=timezone.utc) - timedelta(days=1)).timestamp()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This URL has expired."})
        }

    # Generate a new password
    password = secrets.token_urlsafe(8)

    # Encrypt password
    f = Fernet(os.environ['SECRET_KEY'].encode())
    password_encrypted = f.encrypt(password.encode()).decode()

    # Save new password
    try:
        response = dynamodb.update_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            UpdateExpression='REMOVE #recover_code, #recover_code_time, #another SET #password = :password',
            ConditionExpression='attribute_exists(#username)',
            ExpressionAttributeNames={
                '#username': 'username',
                '#password': 'password',
                '#recover_code': 'recover_code',
                '#recover_code_time': 'recover_code_time',
                '#another': 'another',
            },
            ExpressionAttributeValues={
                ':password': {'S': password_encrypted},
            }
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
            'body': json.dumps({"message": "An error generating recovering the account. Please try again in a few minutes."})
        }

    # Return the new credentials
    return {
        'statusCode': 200,
        'body': json.dumps({"message": "Account recovered!", "password": password})
    }

def lambda_handler(event, context):
    # Check required parameters
    body = json.loads(event['body'])

    # Check Cloudflare Turnstile token validity
    url = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    data = {
        "secret": os.environ['TURNSTILE_SECRET'],
        "response": body.get('turnstile'),
    }
    response = requests.post(url, data=data)
    response = response.json()

    if not response['success']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The Cloudflare token is not valid. Please try again."})
        }

    if 'code' not in body:
        return request(body)
    return submit(body)
