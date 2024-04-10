import os
import re
import json
import boto3
import pyotp
import secrets
import logging
import hashlib
import requests
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
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check required parameters
    username = event['requestContext']['authorizer']['lambda']['username']
    body = json.loads(event['body'])
    cookies = {i.split('=')[0]: i.split('=')[1] for i in event.get('cookies', [])}

    if 'mode' not in body or body['mode'] not in ['init','verify']:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    if body['mode'] == 'init':
        # Check parameters
        if not {'google_client_id','google_client_secret'}.issubset(body.keys()):
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "Invalid parameters."})
            }

        # Return token as a cookie
        expiration = datetime.now(tz=timezone.utc) + timedelta(hours=1)
        return {
            'statusCode': 200,
            "cookies": [
                f"google_client_id={body['google_client_id']}; Expires={expiration.strftime('%a, %d %b %Y %H:%M:%S GMT')}; Secure; HttpOnly; SameSite=None; Path=/", # Change None to Strict for Production
                f"google_client_secret={body['google_client_secret']}; Expires={expiration.strftime('%a, %d %b %Y %H:%M:%S GMT')}; Secure; HttpOnly; SameSite=None; Path=/", # Change None to Strict for Production
            ],
            'body': json.dumps({'message': "Please confirm your identity."})
        }

    if body['mode'] == 'verify':
        # Check parameters
        if not {'google_client_id','google_client_secret'}.issubset(cookies.keys()) or 'google_client_code' not in body:
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "Invalid parameters."})
            }

        # Verify Google Oauth Code
        data = {
            "client_id": cookies['google_client_id'],
            "client_secret": cookies['google_client_secret'],
            "code": body['google_client_code'],
            "redirect_uri": "http://localhost:5500/callback.html",
            "grant_type": 'authorization_code',
        }
        response = requests.post("https://oauth2.googleapis.com/token", data=data)
        response_data = response.json()

        print(response.text)
        if not response.ok:
            return {
                'statusCode': 400,
                'body': json.dumps({"message": "The verification process failed."})
            }

        # Store credentials in DynamoDB
        try:
            dynamodb.update_item(
                TableName='retrox-users',
                Key={'username': {'S': username}},
                ExpressionAttributeNames={
                    '#google_client_id': 'google_client_id',
                    '#google_client_secret': 'google_client_secret',
                    '#google_refresh_token': 'google_refresh_token',
                },
                ExpressionAttributeValues={
                    ':google_client_id': {
                        'S': cookies['google_client_id']
                    },
                    ':google_client_secret': {
                        'S': cookies['google_client_secret']
                    },
                    ':google_refresh_token': {
                        'S': response_data['refresh_token']
                    },
                },
                UpdateExpression='SET #google_client_id = :google_client_id, #google_client_secret = :google_client_secret, #google_refresh_token = :google_refresh_token',
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

        # Return success and clear session cookies
        return {
            'statusCode': 200,
            "cookies": [
                f"google_client_id=; Max-Age=0; Secure; HttpOnly; SameSite=None; Path=/", # Change None to Strict for Production
                f"google_client_secret=;  Max-Age=0; Secure; HttpOnly; SameSite=None; Path=/", # Change None to Strict for Production
            ],
            'body': json.dumps({'message': "Identity verified.", 'google_client_id': cookies['google_client_id']})
        }

def change_two_factor(event):
    # Initialize DynamoDB client
    dynamodb = boto3.client('dynamodb')

    # Check required parameters
    body = json.loads(event['body'])

    if 'enable' not in body:
        return {
            'statusCode': 400,
            'body': json.dumps({"message": "Invalid parameters."})
        }

    # Get variables
    username = event['requestContext']['authorizer']['lambda']['username']
    enable = body['enable']

    if enable:
        # Generate new code
        if 'code' not in body:
            # Generate OTP Secret
            otp_secret = pyotp.random_base32()

            # Return OTP
            return {
                'statusCode': 200,
                'body': json.dumps({
                    "message": "Scan the QR and enter the code.",
                    "2fa_key": otp_secret,
                    "2fa_uri": pyotp.totp.TOTP(otp_secret).provisioning_uri(name=username, issuer_name='RetroX Emulator'),
                })
            }
        else:
            # Check parameters
            if not {'key','code'}.issubset(body.keys()):
                return {
                    'statusCode': 400,
                    'body': json.dumps({"message": "Invalid parameters."})
                }

            # Verify 2FA
            totp = pyotp.TOTP(body['key'])
            if not totp.verify(body['code'], valid_window=1):
                return {
                    'statusCode': 400,
                    'body': json.dumps({"message": "The code is not valid."})
                }

            # Enable 2FA
            try:
                dynamodb.update_item(
                    TableName='retrox-users',
                    Key={'username': {'S': username}},
                    ExpressionAttributeNames={
                        '#2fa_secret': '2fa_secret',
                    },
                    ExpressionAttributeValues={
                        ':2fa_secret': {
                            'S': body['key']
                        },
                    },
                    UpdateExpression='SET #2fa_secret = :2fa_secret',
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
                'body': json.dumps({"message": "Two-Factor enabled."})
            }
    else:
        # Disable 2FA
        try:
            dynamodb.update_item(
                TableName='retrox-users',
                Key={'username': {'S': username}},
                ExpressionAttributeNames={
                    '#2fa_secret': '2fa_secret',
                },
                UpdateExpression='REMOVE #2fa_secret',
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
            'body': json.dumps({"message": "Two-Factor disabled."})
        }

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
    elif event['requestContext']['http']['path'] == '/profile/2fa':
        return change_two_factor(event)
    elif event['requestContext']['http']['path'] == '/profile/delete':
        return delete_account(event)

    return {
        'statusCode': 400,
        'body': json.dumps({"message": "Invalid method."})
    }
