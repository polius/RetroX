import os
import jwt

def lambda_handler(event, context):
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
