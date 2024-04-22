import os
import boto3
import time

class transfer:
    def __init__(self):
        # Boto3 Session
        session = boto3.Session(profile_name='retrox')

        # S3
        self.bucket_name = 'retrox.app'
        self.upload_path = '../web'
        self.s3 = session.client(service_name='s3')

        # Cloudfront
        self.cloudfront = session.client(service_name='cloudfront')
        self.distribution_id = 'ELG0J3S0M95FF'

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
            params = {"Bucket": self.bucket_name}
            response = self.s3.list_objects_v2(**params)
            if 'Contents' in response:
                for obj in response['Contents']:
                    self.s3.delete_object(Bucket=self.bucket_name, Key=obj['Key'])
            else:
                print("The bucket is already empty.")
            
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
                    extra_args = {'ContentType': 'text/html'} if s3_file.endswith('.html') else {}
                    s3_file = s3_file.replace('.html','')[1:] if s3_file.startswith('/') else s3_file.replace('.html','')
                    print(f"-- [{i}/{total}] Uploading '{s3_file}' ...")
                    self.s3.upload_file(disk_file, self.bucket_name, s3_file, ExtraArgs=extra_args)
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