import os
import json
import boto3
import logging
import requests
import jwt
from datetime import datetime, timedelta
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

def step1(username, email, secret_key):
    # Get DynamoDB user
    try:
        response = dynamodb.get_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ProjectionExpression='email',
        )
        user = response.get('Item')

    except Exception:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account does not exist."})
        }

    # Check if user is not yet verified
    if user['email']['S'] != email:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "This account does not exist."})
        }

    # Decrypt password
    f = Fernet(secret_key.encode())
    password_decrypted = f.decrypt(user['password']['S'].encode()).decode()

    # Check both passwords
    if password != password_decrypted:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid username or password."})
        }

    # "verify_code": {'S': verify_code},

    # Update user last_login
    try:
        dynamodb.update_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ExpressionAttributeNames={
                '#last_login': 'last_login',
                
            },
            ExpressionAttributeValues={
                ':last_login': {
                    'N': str(int(datetime.utcnow().timestamp())),
                },
            },
            UpdateExpression='SET #last_login = :last_login',
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
    
    # Generate token
    expiration = datetime.utcnow() + timedelta(days=30)
    payload = {'username': username, 'exp': int(expiration.timestamp())}
    token = jwt.encode(payload, secret_key, algorithm='HS256')

    # Return token as a parameter
    return {
        'statusCode': 200,
        'body': json.dumps({'token': token, 'username': username, 'remember': remember})
    }

    # Return token as a cookie
    cookie_expires = expiration.strftime('%a, %d %b %Y %H:%M:%S GMT')
    return {
        'statusCode': 200,
        "cookies": [
            f"token={token}; Expires={cookie_expires}; Secure; HttpOnly; SameSite=Strict; Path=/"
        ],
        'body': json.dumps({'username': username, 'expires': int(expiration.timestamp())})
    }

def step2(body):
    pass


def lambda_handler(event, context):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check required parameters
    body = json.loads(event['body'])

    if 'code' not in body and not {'username','email','token'}.issubset(body.keys()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The username and email are required."})
        }

    # Get variables
    username = body.get('username')
    email = body.get('email')
    token = body.get('token')
    secret_key = os.environ['SECRET_KEY']

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

    if 'code' not in body:
        return step1(username, email, secret_key)
    return step2(username, email)
