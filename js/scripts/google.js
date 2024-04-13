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

// Compress Data to gzip
async function compress(data) {
  const stream = new Blob([data]).stream();
  const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));
  const compressedResponse = await new Response(compressedStream);
  return await compressedResponse.blob();
}

// Decompress gzip data
async function decompress(blob) {
  let decompressionStream = new DecompressionStream("gzip");
  let decompressedStream = blob.stream().pipeThrough(decompressionStream);
  return await new Response(decompressedStream).blob();
}

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
async function googleDriveToken() {
  await checkLogin()
  const response = await fetch("https://api.retrox.app/profile/google", {
    method: "GET",
    credentials: 'include',
  })

  const json = await response.json()
  if (response.ok) return json['token']
  else throw new Error({"message": json['message']})
}

// List files
async function listFiles(accessToken, query) {
  const encodedQuery = query === undefined ? encodeURIComponent("trashed = false") : encodeURIComponent(query)
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodedQuery}`, {
    method: 'GET',
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
  })

  const json = await response.json()
  if (response.ok) return json.files
  else throw new Error(json['error']['message'])
}

async function createFolder(accessToken, folderName, folderID) {    
  var metadata = {
    'name': folderName,
    'mimeType': "application/vnd.google-apps.folder",
    'parents': folderID === undefined ? [] : [folderID],
  };

  var form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
    body: form
  })

  const json = await response.json()
  if (response.ok) return json.id
  else throw new Error(json['error']['message'])
}

async function createFile(accessToken, fileName, fileContent, folderID) {    
  var metadata = {
    'name': fileName,
    'mimeType': fileContent.type,
    'parents': folderID === undefined ? [] : [folderID],
  };

  var form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileContent);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
    body: form
  })

  const json = await response.json()
  if (response.ok) return blobjson
  else throw new Error(json['error']['message'])
}

async function getFile(accessToken, fileID) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileID}?alt=media`, {
    method: 'GET',
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
  })

  if (response.ok) return await response.blob()
  else throw new Error(await response.blob()['error']['message'])
}

async function deleteFile(accessToken, fileID) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileID}`, {
    method: 'DELETE',
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const json = await response.json()
    throw new Error(json['error']['message'])
  }
}

async function onLoad() {
  // Get Google API Access Token from Backend 
  const accessToken = await googleDriveToken()

  // Check if RetroX Folder exists
  const query = "name = 'RetroX' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  var list = await listFiles(accessToken, query)
  if (list.length == 0) { console.log("Folder created."); await createFolder(accessToken, 'RetroX') }
  // else { console.log("Folder deleted."); await deleteFile(accessToken, list[0]['id']) }

  // Create File inside RetroX folder
  const file = new Blob(['Hello World'], { type: 'text/plain' });
  // const file = compress('Hello World')
  // await createFile(accessToken, 'README.md', file, list[0]['id'])
  // console.log("File created.")

  // List all items
  console.log("List items:")
  list = await listFiles(accessToken)
  console.log(list)

  // Get item content
  try {
    console.log("Getting file: " + list[0]['id'])
    const blob = await getFile(accessToken, list[0]['id'])
    console.log(blob)
    const text = await blob.text() // <-- This is not returning the text. Is returning a Promise ?!!
    console.log(text)
  }
  catch (error) {
    console.error(error)
  }
}

window.addEventListener('load', onLoad);

