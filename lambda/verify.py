import os
import json
import boto3
from datetime import datetime, timedelta


def lambda_handler(event, context):
    # Check required parameters
    body = json.loads(event['body'])
    print(body)

    if not {'username','code','token'}.issubset(body.keys()):
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    # Get variables
    username = body['username']
    code = body['code']
    token = body['token']

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

    # Validate account
    try:
        # Initialize DynamoDB client
        dynamodb = boto3.client('dynamodb')

        # Create new account in DynamoDB
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
    except Exception as e:
        print(e)
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid code."})
        }

    return {
        'statusCode': 200,
        'body': json.dumps({"message": "Account verified. Welcome!"})
    }
