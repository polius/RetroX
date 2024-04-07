import os
import re
import json
import requests
import boto3
import secrets
import logging
from datetime import datetime, timedelta, timezone
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

def lambda_handler(event, context):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check required parameters
    body = json.loads(event['body'])

    if not {'username','password','email','token'}.issubset(body.keys()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    # Get variables
    username = body['username']
    password = body['password']
    email = body['email']
    token = body['token']

    # Check email format
    if not re.fullmatch(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b', email):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This email is not valid."})
        }

    # Check username format
    if not re.match(r'^[0-9a-zA-Z\-_\.]+$', username):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The username must contain the following characters: 0-9, a-z, A-Z, Hyphen (-), Underscore (_), Period (.)"})
        }

    # Check password requirements
    if len(password) < 8:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The password must contain at least 8 characters."})
        }

    # Check Cloudflare Turnstile token validity
    url = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    data = {
        "secret": os.environ['TURNSTILE_SECRET'],
        "response": token,
    }
    response = requests.post(url, data=data)
    response = response.json()

    if not response['success']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The Cloudflare token is not valid. Please try again."})
        }

    # Encrypt password
    f = Fernet(os.environ['SECRET_KEY'].encode())
    password_encrypted = f.encrypt(password.encode()).decode()

    # Generate verify code
    verify_code = secrets.token_urlsafe(32)

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

    # Create user in DynamoDB
    try:
        dynamodb.put_item(
            TableName='retrox-users',
            Item={
                "username": {'S': username},
                "password": {'S': password_encrypted},
                "email": {'S': email},
                "2fa_enabled": {'BOOL': False},
                "created": {'N': str(int(datetime.now(tz=timezone.utc).timestamp()))},
                "verify_code": {'S': verify_code},
                "ttl": {'N': str(int((datetime.now(tz=timezone.utc) + timedelta(days=1)).timestamp()))},
            },
            ConditionExpression='attribute_not_exists(username)',
        )
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This username already exists."})
        }
    except Exception as e:
        logger.error(str(e))
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "An error occurred creating the user. Please try again in a few minutes."})
        }

    # Build Verify URL
    verify_url = f"https://www.retrox.app/verify.html?username={username}&code={verify_code}&origin=register"

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
        'body': json.dumps({"message": "Account created."})
    }
