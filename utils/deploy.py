import os
import boto3
import time
import mimetypes

class transfer:
    def __init__(self):
        # S3
        self.bucket_name = 'retrox.app'
        self.upload_path = '/home/ec2-user/git/retrox/web/'
        self.s3 = boto3.client(
            service_name='s3',
            aws_access_key_id='',
            aws_secret_access_key='',
            region_name='eu-west-1'
        )
        # Cloudfront
        self.cloudfront = boto3.client(
            service_name='cloudfront',
            aws_access_key_id='',
            aws_secret_access_key='',
            region_name='eu-west-1'
        )
        self.distribution_id = ''

    def start(self):
        print("- Cleaning bucket...")
        self.clean()
        print("- Uploading files...")
        self.upload()
        print("- Invalidating edge locations..")
        self.invalidate()
        print("- Process completed.")

    def clean(self):
        while True:
            params = { "Bucket": self.bucket_name, "Prefix": '/'}
            response = self.s3.list_objects_v2(**params)
            if response['KeyCount'] == 0:
                print("-- No files found.")
                return
            for object in response['Contents']:
                self.s3.delete_object(Bucket=self.bucket_name, Key=object['Key'])
            
            if response['IsTruncated']:
                params['ContinuationToken'] = response['NextContinuationToken']
            else:
                break

    def upload(self):
        total = 0
        for path, _, files in os.walk(self.upload_path):
            for file in files:
                if not file.startswith('.'):
                    total += 1
        i = 1
        for path, _, files in os.walk(self.upload_path):
            for file in files:
                if not file.startswith('.'):
                    disk_file = os.path.join(path, file)
                    s3_file = os.path.join(path[len(self.upload_path):], file)
                    print(f"-- [{i}/{total}] Uploading '{s3_file}'...")
                    mimetype = mimetypes.MimeTypes().guess_type(disk_file)[0]
                    self.s3.upload_file(disk_file, self.bucket_name, s3_file, ExtraArgs={'ContentType': mimetype}) # text/html
                    i += 1

    def invalidate(self):
        res = self.cloudfront.create_invalidation(
            DistributionId=self.distribution_id,
            InvalidationBatch={
                'Paths': {
                    'Quantity': 1,
                    'Items': ['/*']
                },
                'CallerReference': str(time.time()).replace(".", "")
            }
        )
        return res['Invalidation']['Id']

if __name__ == "__main__":
    t = transfer()
    t.start()