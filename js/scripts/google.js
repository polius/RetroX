// https://developers.google.com/drive/api/reference/rest/v3/files#File

// RetroX
// --> Games
// --> Covers
// --> Saves
// --> States

// GET /profile/google : Returns Token

// if error:
//     --> Get new refresh token (transparently) + repeat GET /profile/google
//     if error:
//         --> Start the authentication process again (new tab if user is playing).

// https://www.googleapis.com/drive/v2/files/${FILE_ID}?alt=media&source=downloadUrl

// 1. google.js: googleDriveAuth() --> opens Google Login --> callback.html --> POST /profile/google (verify)

// Profile
// Games
// --> Playing a game.

// Start authentication process
function googleDriveAuth(clientID, origin) {
  var form = document.createElement('form');
  form.setAttribute('method', 'GET');
  form.setAttribute('action', 'https://accounts.google.com/o/oauth2/v2/auth');
  if (!origin) form.setAttribute('target', '_blank');

  var params = {
    'client_id': clientID,
    'redirect_uri': 'http://localhost:5500/callback.html', // 'https://www.retrox.app/callback',
    'scope': 'https://www.googleapis.com/auth/drive.file',
    'include_granted_scopes': 'true',
    'access_type': 'offline',
    'prompt': 'consent',
    'response_type': 'code',
    'state': origin === undefined ? '' : origin,
  };

  for (var p in params) {
    var input = document.createElement('input');
    input.setAttribute('type', 'hidden');
    input.setAttribute('name', p);
    input.setAttribute('value', params[p]);
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

// Get Google API Token
async function googleDriveToken(origin) {
  try {
    await checkLogin()
    const response = await fetch("https://api.retrox.app/profile/google", {
      method: "GET",
      credentials: 'include',
    })

    const json = await response.json()
    if (!response.ok) {
      console.log(json['message'])
      // googleDriveAuth(localStorage.getItem('google_client_id'), origin)
      // throw new Error({"message": json['message']})
    }
    else return json['token']
  }
  catch (error) {
    console.log(error)
    return {"ok": false, "message": "An error occurred. Please try again."}
  }
}

// Check if folder exists
async function existsFolder(token) {
  try {
    const access_token = await googleDriveToken()
    const encoded_query = encodeURIComponent("name = 'RetroX' and mimeType = 'application/vnd.google-apps.folder' and trashed = false")
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encoded_query}`, {
      method: 'GET',
      headers: {
        "Authorization": `Bearer ${access_token}`,
      },
    })

    const json = await response.json()
    if (response.ok) {
      console.log(json)
      // {
      //     "kind": "drive#fileList",
      //     "incompleteSearch": false,
      //     "files": []
      // }
    }
    else {

    }
  }
  catch (error) {
    console.log(error)
    return {"ok": false, "message": "An error occurred. Please try again."}
  }
}

async function createFile(fileName, fileContent, folderID, isFolder) {    
  try {
    // var fileContent = 'Hello World';
    var file = new Blob([fileContent], { type: 'text/plain' });
    var metadata = {
      'name': fileName,
      'mimeType': isFolder ? "application/vnd.google-apps.folder" : fileContent.type, // 'text/plain',
      'parents': folderID === undefined ? [] : [folderID],
    };

    var form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);

    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: {
        "Authorization": `Bearer ${access_token}`,
      },
      body: form
    })

    if (response.ok) {

    }
    else {

    }
  }
  catch (error) {
    console.log(error)
    return {"ok": false, "message": "An error occurred. Please try again."}
  }
}

async function getFile(fileID) {
  try {
    const access_token = await googleDriveToken()
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileID}`, {
      method: 'GET',
      headers: {
        "Authorization": `Bearer ${access_token}`,
      },
    })

    const json = await response.json()
    if (response.ok) {
      console.log(json)
      // {
      //     "kind": "drive#fileList",
      //     "incompleteSearch": false,
      //     "files": []
      // }
    }
    else {

    }
  }
  catch (error) {
    console.log(error)
    return {"ok": false, "message": "An error occurred. Please try again."}
  }
}

async function deleteFile(fileID) {
  try {
    const access_token = await googleDriveToken()
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileID}`, {
      method: 'DELETE',
      headers: {
        "Authorization": `Bearer ${access_token}`,
      },
    })

    if (response.ok) {
      console.log("OK!")
      // {
      //     "kind": "drive#fileList",
      //     "incompleteSearch": false,
      //     "files": []
      // }
    }
    else {
      console.log("NOT OK!")
    }
  }
  catch (error) {
    console.log(error)
    return {"ok": false, "message": "An error occurred. Please try again."}
  }
}

async function onLoad() {
  console.log(window.location.host)
  console.log(window.location.pathname)
  let origin = 'profile'
  let token = await googleDriveToken(localStorage.getItem('google_client_id'), origin)
  console.log(token)
}

// window.addEventListener('load', onLoad);

