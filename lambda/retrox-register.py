import os
import re
import json
import boto3
from datetime import datetime, timedelta
from cryptography.fernet import Fernet

def create_dynamodb_user(username, password, email):
    try:
        # Initialize DynamoDB client
        dynamodb = boto3.client('dynamodb')

        # Create new user in dynamodb
        response = dynamodb.put_item(
            TableName='retrox-users',
            Item={
                "username": {'S': username},
                "password": {'S': password},
                "email": {'S': email},
                "verified": {'BOOL': False},
                "created": {'N': str(int(datetime.utcnow().timestamp()))},
                "ttl": {'N': str(int((datetime.utcnow() + timedelta(days=30)).timestamp()))},
            },
            ConditionExpression='attribute_not_exists(username) AND attribute_not_exists(email)',
        )
        return response.get('Item')
    except dynamodb.exceptions.ConditionalCheckFailedException:
        raise Exception("This username/email already exists. Choose another one.")
    except dynamodb.exceptions.ClientError:
        raise Exception("An error occurred. Please try again.")

def lambda_handler(event, context):
    # Check required parameters
    body = json.loads(event['body'])

    if 'username' not in body or 'password' not in body or 'email' not in body:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The username and password are required."})
        }

    # Get variables
    username = body['username']
    password = body['password']
    email = body['email']

    # Check username format
    if not re.match(r'^[0-9a-zA-Z\-_\.]+$', username):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The username is not valid. Please make sure it contains the following characters: 0-9, a-z, A-Z, Hyphen (-), Underscore (_), Period (.)"})
        }

    # Check password requirements
    if len(password) < 8:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The password is not valid. Please make sure it contains at least 8 characters."})
        }

    # Encrypt password
    f = Fernet(os.environ['SECRET_KEY'].encode())
    password_encrypted = f.encrypt(password.encode()).decode()

    # Get DynamoDB user
    try:
        create_dynamodb_user(username, password_encrypted, email)
        return {
            'statusCode': 200,
            'body': json.dumps({"message": "User successfully registered."})
        }

    except Exception as e:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": str(e)})
        }
