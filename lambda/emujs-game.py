import os
import json
import boto3
import rsa
from datetime import datetime, timedelta
from botocore.signers import CloudFrontSigner

# Initialize Boto3 clients
dynamodb = boto3.client('dynamodb')
s3 = boto3.client('s3')

def get_dynamodb_user(username):
    try:
        response = dynamodb.get_item(
            TableName='emujs-users',
            Key={'username': {'S': username}},
            ProjectionExpression='username'
        )
        return response.get('Item')
    except dynamodb.exceptions.ClientError:
        return None

def rsa_signer(message):
    with open('private_key.pem') as file:
        private_key = file.read()
    return rsa.sign(message, rsa.PrivateKey.load_pkcs1(private_key.encode('utf8')), 'SHA-1')

def lambda_handler(event, context):
    # Get environment variables
    s3_bucket = os.environ.get('s3_bucket')
    s3_path = os.environ.get('s3_path')
    cf_key_id = os.environ['cloudfront_key_id']
    cf_url = os.environ['cloudfront_url']

    # Parse JSON body
    body = json.loads(event['body'])

    # Check parameters
    if 'game' not in body or 'action' not in body:
        return {
            'statusCode': 400,
            'body': json.dumps("The 'game' and 'action' parameters are needed.")
        }
    
    # Get parameters
    game = body['game']
    action = body['action']
    username = event['requestContext']['authorizer']['lambda']['username']

    # Check if user exists
    user = get_dynamodb_user(username)
    if not user:
        return {
            'statusCode': 401,
            'body': json.dumps("This user does not exist.")
        }

    # Generate a S3 pre-signed URL for POST request
    if event['requestContext']['http']['method'] == 'POST' and action == 'save':
        s3_key = f"{s3_path}/{username}/{game}"
        presigned_url_save = s3.generate_presigned_post(Bucket=s3_bucket, Key=f"{s3_key}.save.gz", ExpiresIn=60, Conditions=[['content-length-range', 0, 10485760]])
        presigned_url_state = s3.generate_presigned_post(Bucket=s3_bucket, Key=f"{s3_key}.state.gz", ExpiresIn=60, Conditions=[['content-length-range', 0, 10485760]])
        return {
            'statusCode': 200,
            'body': json.dumps({"save": presigned_url_save, "state": presigned_url_state})
        }

    # Generate a Cloudfront pre-signed URL for GET request
    elif event['requestContext']['http']['method'] == 'POST' and action in ('load_save','load_state'):
        cf_signer = CloudFrontSigner(cf_key_id, rsa_signer)
        url = f"{cf_url}{s3_path[s3_path.find('/'):]}/{username}/{game}{'.save' if action == 'load_save' else '.state'}.gz"
        date_less_than = datetime.now() + timedelta(minutes=5)
        presigned_url = cf_signer.generate_presigned_url(url=url, date_less_than=date_less_than)
        return {
            'statusCode': 200,
            'body': json.dumps(presigned_url)
        }

    return {
        'statusCode': 400,
        'body': json.dumps("Not a valid resource.")
    }