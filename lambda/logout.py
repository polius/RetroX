import json

def lambda_handler(event, context):
    return {
        "statusCode": 200,
        "cookies": [
            "token=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"
        ],
        "body": json.dumps({"message": "Success"})
    }
