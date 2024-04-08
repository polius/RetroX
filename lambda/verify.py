import os
import json
import boto3
import requests
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

def lambda_handler(event, context):
    # Check required parameters
    body = json.loads(event['body'])

    if not {'username','code','origin','turnstile'}.issubset(body.keys()) or body['origin'] not in ['register','profile']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid URL."})
        }

    # Get variables
    username = body['username']
    code = body['code']
    origin = body['origin']
    turnstile = body['turnstile']

    # Check Cloudflare Turnstile token validity
    url = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    data = {
        "secret": os.environ['TURNSTILE_SECRET'],
        "response": turnstile,
    }
    response = requests.post(url, data=data)
    response = response.json()

    if not response['success']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "The Cloudflare token is not valid. Please try again."})
        }

    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Validate account
    if origin == 'register':
        try:
            response = dynamodb.update_item(
                TableName='retrox-users',
                Key={'username': {'S': username}},
                UpdateExpression='REMOVE #verify_code, #ttl',
                ConditionExpression='attribute_exists(#username) AND #verify_code = :verify_code',
                ExpressionAttributeNames={
                    '#username': 'username',
                    '#verify_code': 'verify_code',
                    '#ttl': 'ttl',
                },
                ExpressionAttributeValues={
                    ':verify_code': {'S': code},
                }
            )
        except dynamodb.exceptions.ConditionalCheckFailedException:
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "This URL is not valid or has expired."})
            }
        except Exception as e:
            logger.error(e)
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "An error occurred retrieving the user"})
            }

    # Change email
    elif origin == 'profile':
        try:
            response = dynamodb.update_item(
                TableName='retrox-users',
                Key={'username': {'S': username}},
                UpdateExpression='REMOVE #verify_code, #verify_code_ttl, #new_email SET #email = #new_email',
                ConditionExpression='attribute_exists(#username) AND #verify_code = :verify_code AND attribute_exists(#verify_code_ttl) AND #verify_code_ttl > :now',
                ExpressionAttributeNames={
                    '#username': 'username',
                    '#verify_code': 'verify_code',
                    '#verify_code_ttl': 'verify_code_ttl',
                    '#email': 'email',
                    '#new_email': 'new_email',
                },
                ExpressionAttributeValues={
                    ':verify_code': {'S': code},
                    ':now': {'N': str(int(datetime.now(tz=timezone.utc).timestamp()))},
                }
            )
        except dynamodb.exceptions.ConditionalCheckFailedException:
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "This URL is not valid or has expired."})
            }
        except Exception as e:
            logger.error(e)
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "An error occurred retrieving the user"})
            }

    return {
        'statusCode': 200,
        'body': json.dumps({"message": "Account verified!"})
    }
