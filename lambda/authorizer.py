import os
import jwt

def authorizer_default(event):
    # Get variables
    secret_key = os.environ['SECRET_KEY']
    token = event['headers'].get('authorization')

    # Check if the request contain Authorization
    if not token:
        return {"isAuthorized": False}

    # Check token validity
    try:
        decoded = jwt.decode(token[7:], secret_key, algorithms=['HS256'])
        return {"isAuthorized": True, "context": {"username": decoded['username']}}
    except Exception:
        return {"isAuthorized": False}

def authorizer_cookie(event):
    # Get variables
    secret_key = os.environ['SECRET_KEY']
    cookies = event.get('cookies')

    # Check if the request contain cookies
    if not cookies:
        return {"isAuthorized": False}

    # Extract token from cookies
    token = None
    for cookie in cookies:
        if cookie.startswith('token='):
            token = cookie.split('=')[1]

    # Check if authorization token exists
    if not token:
        return {"isAuthorized": False}

    # Check token validity
    try:
        decoded = jwt.decode(token, secret_key, algorithms=['HS256'])
        return {"isAuthorized": True, "context": {"username": decoded['username']}}
    except Exception:
        return {"isAuthorized": False}


def lambda_handler(event, context):
    # return authorizer_default(event)
    return authorizer_cookie(event)
