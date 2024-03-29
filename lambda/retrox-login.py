import os
import json
import boto3
import jwt
from datetime import datetime, timedelta
from cryptography.fernet import Fernet

# Initialize DynamoDB client
dynamodb = boto3.client('dynamodb')

def get_dynamodb_user(username):
    try:
        response = dynamodb.get_item(
            TableName='retrox-users',
            Key={'username': {'S': username}},
            ProjectionExpression='password,verified'
        )
        return response.get('Item')
    except dynamodb.exceptions.ClientError:
        return None

def update_dynamodb_user(username):
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
       print("This username does not exist.")
    except dynamodb.exceptions.ClientError:
        pass

def lambda_handler(event, context):
    # Check required parameters
    body = json.loads(event['body'])

    if 'username' not in body or 'password' not in body:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The username and password are required."})
        }

    # Get variables
    username = body['username']
    password = body['password']
    secret_key = os.environ['SECRET_KEY']

    # Get DynamoDB user
    user = get_dynamodb_user(username)

    # Check if user exists
    if not user:
        return {
            'statusCode': 401,
            'body': json.dumps({"message": "Invalid username or password."})
        }

    if not user['verified']['BOOL']:
        return {
            'statusCode': 401,
            'body': json.dumps({"message": "The email has not been validated. Check your email inbox to validate this account."})
        }

    # Decrypt password
    f = Fernet(secret_key.encode())
    password_decrypted = f.decrypt(user['password']['S'].encode()).decode()

    # Check both passwords
    if password != password_decrypted:
        return {
            'statusCode': 401,
            'body': json.dumps({"message": "Invalid username or password."})
        }

    # Update user last_login
    update_dynamodb_user(username)
    
    # Generate token
    expiration = datetime.utcnow() + timedelta(days=30)
    payload = {'username': username, 'exp': int(expiration.timestamp())}
    token = jwt.encode(payload, secret_key, algorithm='HS256')

    # Return token
    cookie_expires = expiration.strftime('%a, %d %b %Y %H:%M:%S GMT')
    return {
        'statusCode': 200,
        "cookies": [
            f"token={token}; Expires={cookie_expires}; Secure; HttpOnly; SameSite=Strict; Path=/"
        ],
        'body': json.dumps({'username': username, 'expires': int(expiration.timestamp())})
    }
