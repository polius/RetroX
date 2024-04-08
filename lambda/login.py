import os
import json
import boto3
import logging
import requests
import pyotp
import jwt
from datetime import datetime, timedelta, timezone
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

def lambda_handler(event, context):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Get variables
    secret_key = os.environ['SECRET_KEY']
    body = json.loads(event['body'])
    cookies = {i.split('=')[0]: i.split('=')[1] for i in event.get('cookies')}
    params = {}

    # Check parameters
    if 'mode' not in body or body['mode'] not in ['login','two-factor']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    if body['mode'] == 'login':
        if not {'username','password','remember','turnstile'}.issubset(body.keys()):
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "Invalid parameters."})
            }
        params = {
            "mode": body['mode'],
            "username": body['username'],
            "password": body['password'],
            "remember": body['remember'],
            "turnstile": body['turnstile'],
        }

    elif body['mode'] == 'two-factor':
        if not {'username','password','remember'}.issubset(cookies.keys()) or not {'code','turnstile'}.issubset(body.keys()):
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "Invalid parameters."})
            }
        params = {
            "mode": body['mode'],
            "username": cookies['username'],
            "password": cookies['password'],
            "remember": cookies['remember'],
            "code": body['code'],
            "turnstile": body['turnstile'],
        }

    # Check Cloudflare Turnstile validity
    url = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    data = {
        "secret": os.environ['TURNSTILE_SECRET'],
        "response": params['turnstile'],
    }
    response = requests.post(url, data=data)
    response = response.json()

    if not response['success']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The Cloudflare token is not valid. Please try again."})
        }

    # Get DynamoDB user
    response = dynamodb.get_item(
        TableName='retrox-users',
        Key={'username': {'S': params['username']}},
        ProjectionExpression='#email, #password, #verify_code, #2fa_secret',
        ExpressionAttributeNames={
            '#email': 'email',
            '#password': 'password',
            '#verify_code': 'verify_code',
            '#2fa_secret': '2fa_secret',
        }
    )
    user = response.get('Item')

    # Check if user exists
    if not user:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid username or password."})
        }

    # Check if user is not yet verified
    if user.get('verify_code'):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Account not verified. Check your email to complete the verification process."})
        }

    # Decrypt password
    f = Fernet(secret_key.encode())
    password_decrypted = f.decrypt(user['password']['S'].encode()).decode() if params['mode'] == 'login' else params['password']

    # Check both passwords
    if params['password'] != password_decrypted:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid username or password."})
        }

    # Check if 2FA is enabled and user is requesting to log in
    if params['mode'] == 'login' and '2fa_secret' in user:
        # Generate cookie
        expiration = datetime.now(tz=timezone.utc) + timedelta(days=1)
        cookie_expires = expiration.strftime('%a, %d %b %Y %H:%M:%S GMT')
        return {
            'statusCode': 200,
            "cookies": [
                f"username={params['username']}; Expires={cookie_expires}; Secure; HttpOnly; SameSite=None; Path=/",
                f"password={user['password']['S']}; Expires={cookie_expires}; Secure; HttpOnly; SameSite=None; Path=/",
                f"remember={params['remember']}; Expires={cookie_expires}; Secure; HttpOnly; SameSite=None; Path=/",
            ],
            'body': json.dumps({'2FA': 'Required'})
        }

    # Check two factor code
    if params['mode'] == 'two-factor':
        if '2fa_secret' not in user:
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "This user does not have Two-Factor enabled."})
            }

        # Check Two-Factor
        totp = pyotp.TOTP(user['2fa_secret']['S'])
        if not totp.verify(params['code'], valid_window=1):
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "The code is not valid."})
            }

    # Update user last_login
    try:
        dynamodb.update_item(
            TableName='retrox-users',
            Key={'username': {'S': params['username']}},
            ExpressionAttributeNames={
                '#last_login': 'last_login',
            },
            ExpressionAttributeValues={
                ':last_login': {
                    'N': str(int(datetime.now(tz=timezone.utc).timestamp())),
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
    expiration = datetime.now(tz=timezone.utc) + timedelta(days=30)
    payload = {'username': params['username'], 'exp': int(expiration.timestamp())}
    token = jwt.encode(payload, secret_key, algorithm='HS256')

    # Return token as a parameter
    # return {
    #     'statusCode': 200,
    #     'body': json.dumps({'token': token, 'email': user['email']['S'], 'username':params['username'], 'remember': params['remember'], '2fa': '2fa_secret' in user})
    # }

    # Return token as a cookie
    return {
        'statusCode': 200,
        "cookies": [
            f"token={token}; Expires={expiration.strftime('%a, %d %b %Y %H:%M:%S GMT')}; Secure; HttpOnly; SameSite=None; Path=/" # Change None to Strict for Production
        ],
        'body': json.dumps({'email': user['email']['S'], 'username': params['username'], 'remember': params['remember'], '2fa': '2fa_secret' in user, 'expires': int(expiration.timestamp())})
    }
