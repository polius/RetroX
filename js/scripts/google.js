// RetroX
// --> Games
// --> Covers
// --> Saves
// --> States

// Profile
// Games
// --> Playing a game.

class GoogleDriveAPI {
  constructor() {
    this.controller = new AbortController();
    this.xhr = new XMLHttpRequest();
  }

  async test() {
    // Get Google API Access Token from Backend 
    const accessToken = await this.getToken()

    // Check if RetroX Folder exists
    const query = "name = 'RetroX' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    var list = await this.listFiles(accessToken, query)
    if (list.length == 0) { console.log("Folder created."); await this.createFolder(accessToken, 'RetroX') }
    // else { console.log("Folder deleted."); await this.deleteFile(accessToken, list[0]['id']) }

    // Create File inside RetroX folder
    // const file_blob = new Blob(['Hello World'], { type: 'text/plain' });
    const file = await this.compress('Hello World Compressed - Method2!')
    // await this.createFile(accessToken, 'README.md', file, list[0]['id'])
    // console.log("File created.")

    // List all items
    console.log("List items:")
    list = await this.listFiles(accessToken)
    console.log(list)

    // Get item content
    console.log("Getting file: " + list[0]['id'])
    try {
      // Start the fetch, obtain a reader and get total length
      const response = await this.getFile(accessToken, list[0]['id'])
      const reader = response.body.getReader();
      const contentLength = +response.headers.get('Content-Length');

      // Read the data
      let receivedLength = 0;
      let chunks = [];
      while (true) {
        const {done, value} = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
        receivedLength += value.length;
        console.log(`Progress: ${(Math.round(receivedLength * 100) / contentLength).toFixed(2)}%`)
      }

      // Convert chunks to blob
      let blob_compressed = new Blob(chunks);

      // Decompress
      let blob = await this.decompress(blob_compressed)

      // Read text
      let text = await blob.text()
      console.log(text)

    } catch (error) {
      if (error.name == 'AbortError') {
        console.error("Aborted!");
      } else {
        console.error(error)
      }
    }
  }

  // Start Google authentication process
  auth(clientID, origin) {
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
  async getToken() {
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
  async listFiles(accessToken, query) {
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

  async createFolder(accessToken, folderName, folderID) {    
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

  // Upload file to Google Drive
  async createFile(accessToken, fileName, fileContent, folderID) {
    return new Promise((resolve, reject) => {
      // Create a new XMLHttpRequest object
      let xhr = new XMLHttpRequest();
      // Abort request
      // xhr.abort();

      xhr.open("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id");
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);

      // Track Upload progress
      xhr.upload.onprogress = function(event) {
        console.log(`Uploaded ${event.loaded} of ${event.total}`);
        console.log(`Progress: ${(Math.round(event.loaded * 100) / event.total).toFixed(2)}%`)
      };

      // Track Completion
      xhr.onloadend = function() {
        if (xhr.status == 200) {
          console.log("Success");
          resolve()
        } else {
          console.error(`Error ${xhr.status}: ${xhr.statusText}`);
          reject(xhr.statusText)
        }
      };

      // Track abort
      xhr.onabort = function () {
        console.log("Request aborted.")
        reject("Request aborted.")
      }

      // Define body parameters
      var metadata = {
        'name': fileName,
        'mimeType': fileContent.type,
        'parents': folderID === undefined ? [] : [folderID],
      };
  
      var form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', fileContent);

      // Start the request
      xhr.send(form);
    })
  }

  // Get file from Google Drive
  async getFile(accessToken, fileID) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileID}?alt=media`, {
      method: 'GET',
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    })
    return response
  }

  // Delete file from Google Drive
  async deleteFile(accessToken, fileID) {
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

  // Compress Data to gzip
  async compress(data, isBlob) {
    const stream = isBlob ? data.stream() : new Blob([data]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));
    const compressedResponse = await new Response(compressedStream);
    return await compressedResponse.blob();
  }

  // Decompress gzip data
  async decompress(blob) {
    let decompressionStream = new DecompressionStream("gzip");
    let decompressedStream = blob.stream().pipeThrough(decompressionStream);
    return await new Response(decompressedStream).blob();
  }
}

const googleDriveAPI = new GoogleDriveAPI();
googleDriveAPI.test()