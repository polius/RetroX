-------
Roadmap
-------

1.0
---
[OK] --> Transition from Cognito to DynamoDB.
--> Fallback EJS_Threads=false if error on current browser (Safari may not be supported).
--> Implement Register.
  [OK] --> Add TTL for new accounts that have registered and have not been validated yet (1 Month). Delete also storage.
[OK] --> Detect if the token has expired when clicking "SAVE" or "LOAD". If so, show again the login form.
--> Send emails to verify user accounts (SES). Once validated, remove TTL from account item.
--> Implement forgot password and enter username and email.
--> Implement delete user.

2.0
---
--> Improve UI
--> Add feature. User profile / account.
--> Add feature: Add, modify, remove games. Handle multiple disks like FFIX. Update DynamoDB total used storage in a new user column.
--> Add feature: Organize games by emulators.
--> Add Ads