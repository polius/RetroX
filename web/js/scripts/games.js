// Variables
var mode = 'new';
var currentGame;
var currentGameName;
var disks = 1;
var nextPageToken = undefined;

// Get elements
const gamesGallery = document.getElementById("gamesGallery");

const actionsModal = document.getElementById('actionsModal');
const actionsModalGameName = document.getElementById('actionsModalGameName');

const manageAlert = document.getElementById("manageAlert");
const gamesModal = document.getElementById('gamesModal');
const gamesModalClose = document.getElementById('gamesModalClose');
const gamesModalAddDisk = document.getElementById('gamesModalAddDisk');
const gamesModalTitle = document.getElementById('gamesModalTitle');
const gamesModalName = document.getElementById('gamesModalName');
const gamesModalDisks = document.getElementById('gamesModalDisks');
const gamesModalGameName = document.getElementById('gamesModalGameName');
const gamesModalRom = document.getElementById('gamesModalRom');
const gamesModalImage = document.getElementById('gamesModalImage');
const gamesModalImageInput = document.getElementById('gamesModalImageInput');
const gamesModalCloseSubmit = document.getElementById('gamesModalCloseSubmit');
const gamesModalSaveSubmit = document.getElementById('gamesModalSaveSubmit');
const gamesModalSaveLoading = document.getElementById('gamesModalSaveLoading');
const gamesModalSelectCover = document.getElementById('gamesModalSelectCover');

const confirmModal = document.getElementById('confirmModal');
const confirmAlert = document.getElementById('confirmAlert');
const confirmModalClose = document.getElementById('confirmModalClose');
const confirmModalGameName = document.getElementById('confirmModalGameName');
const confirmModalCloseSubmit = document.getElementById('confirmModalCloseSubmit');
const confirmModalSubmit = document.getElementById('confirmModalSubmit');
const confirmModalLoading = document.getElementById('confirmModalLoading');

const searchGame = document.getElementById('searchGame');

const gamesLoadMoreDiv = document.getElementById('gamesLoadMoreDiv');
const gamesLoadMoreSubmit = document.getElementById('gamesLoadMoreSubmit');
const gamesLoadMoreLoading = document.getElementById('gamesLoadMoreLoading');

const gamesManageList = document.getElementById('gamesManageList');
const gamesNumber = document.getElementById('gamesNumber');
const gamesManageSubmitButton = document.getElementById('gamesManageSubmitButton');
const gamesManageCloseButton = document.getElementById('gamesManageCloseButton');
const gamesManageAddButton = document.getElementById('gamesManageAddButton');

async function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }

  // Check if Google Drive API is setup
  if (localStorage.getItem('google_client_id') == "null") {
    window.location.href = `${window.location.origin}/setup${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`
  }

  // Load games
  await loadGames()
}

function showAlert(element, type, message) {
  element.innerHTML = `
    <div class="alert alert-${type} ${type != 'info' ? 'alert-dismissible' : ''} d-flex align-items-center" role="alert">
      <div style="text-align:left">
        ${type == 'success' ?
          `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-check-circle-fill" viewBox="0 0 16 16" style="margin-bottom:3px; margin-right:5px">
            <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/>
          </svg>`
        : type == 'danger' ?
          `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-exclamation-circle-fill" viewBox="0 0 16 16" style="margin-bottom:3px; margin-right:5px">
            <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8 4a.905.905 0 0 0-.9.995l.35 3.507a.552.552 0 0 0 1.1 0l.35-3.507A.905.905 0 0 0 8 4m.002 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/>
          </svg>`
        : type == 'warning' ?
          `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-exclamation-triangle-fill" viewBox="0 0 16 16" style="margin-bottom:3px; margin-right:5px">
            <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"/>
          </svg>`
        : type == 'info' ?
          `<span class="spinner-border spinner-border-sm" style="width:15px; height:15px; border-width:2px; margin-right:5px" aria-hidden="true"></span>`
        : ''
        }
        ${message}
      </div>
      ${type == 'info' ? 
        `<!-- <button onclick="cancelUpload()" type="button" class="btn btn-danger" style="position: relative; margin-left: auto;">Cancel</button> -->`
      : type != 'success' ? 
        `<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>`
      : ''
      }
    </div>
  `
}

async function loadGames(name, nextToken) {
  const div = gamesGallery.querySelector('div')

  // Show loading
  if (nextToken === undefined) {
    div.innerHTML = `
      <p style="text-align: center; margin-top:30px; margin-bottom: 0;">Loading games...</p>
      <div class="spinner-border" role="status" style="border-width: 2px; margin-bottom:30px">
        <span class="visually-hidden">Loading...</span>
      </div>
    `
  }

  // Get images metadata
  const images = await googleDriveAPI.getImages(name, nextToken)

  // Add counter
  if (nextToken === undefined) gamesNumber.innerHTML = `(${images.files.length})`
  else gamesNumber.innerHTML = `(${parseInt(gamesNumber.innerHTML.slice(1,-1)) + images.files.length})`

  // Check if there are games to show
  if (nextToken === undefined && images.files.length == 0) {
    if (name === undefined) div.innerHTML = `<p style="text-align: center; margin-top: 40px">There are no games in the library.</p>`
    else div.innerHTML = `<p style="text-align: center; margin-top: 40px">There are no games containing this name.</p>`
    return
  }

  // Load images metadata - first layer
  if (nextToken === undefined) div.innerHTML = ''
  images.files.forEach((element) => {
    div.innerHTML += `
      <div id="${element.id}" class="gallery-item col-xl-3 col-lg-4 col-md-6 col-10">
        <div onclick="gameAction('${element.appProperties.name}')" class="d-flex justify-content-center align-items-center" style="background-color:rgba(156, 145, 129, 0.13); width: 100%; height: 200px; border-radius: 5px; cursor:pointer;">
          <div class="spinner-border" style="width: 3rem; height: 3rem; border-width: 2px;" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
        </div>
        <p style="margin-top:15px; font-weight: 600; font-size: 1.1rem;">${element.appProperties.name}</p>
      </div>
    `
  })

  // Check if there are more games to load
  if (images.nextPageToken !== undefined) {
    nextPageToken = images.nextPageToken
    gamesLoadMoreSubmit.removeAttribute("disabled");
    gamesLoadMoreDiv.style.removeProperty("display");

  }
  else {
    nextPageToken = undefined
    gamesLoadMoreDiv.style.setProperty("display", "none", "important");
  }

  // Load images content - second layer
  await Promise.all(images.files.map(async (element) => {
    await (await googleDriveAPI.getFile(element.id)).blob()
    await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(element.id)).blob())
    const file = await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(element.id)).blob())
    const div = document.getElementById(element.id)
    div.innerHTML = `
      <img onclick="gameAction('${element.appProperties.name}')" src="${URL.createObjectURL(file)}" class="img-fluid img-enlarge" style="cursor:pointer; border-radius:10px" alt="">
      <p style="margin-top:15px; font-weight: 600; font-size: 1.1rem;">${element.appProperties.name}</p>
    `
  }))
}

const searchGames = debounce(searchGamesSubmit);

function debounce(func, delay=500) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}

async function searchGamesSubmit() {
  gamesLoadMoreDiv.style.setProperty("display", "none", "important");
  googleDriveAPI.abort()
  await loadGames(searchGame.value)
}

function gameAction(gameName) {
  // Store selected game name
  currentGameName = gameName
  // Open modal
  actionsModalGameName.innerHTML = gameName;
  const modal = bootstrap.Modal.getOrCreateInstance(actionsModal);
  modal.show()
}

function actionsModalClose() {
  // Close modal
  const modal = bootstrap.Modal.getOrCreateInstance(actionsModal);
  modal.hide()
}

function playGame() {
  window.location.href = `${window.location.origin}/play${window.location.hostname === 'www.retrox.app' ? '' : '.html'}?game=${encodeURIComponent(currentGameName)}`
}

function addGame() {
  mode = 'new'
  manageAlert.innerHTML = ''
  gamesModalTitle.innerHTML = 'New Game'
  gamesModalName.value = ''
  gamesModalImage.style.display = 'none'
  gamesModalSaveLoading.style.display = 'none'
  gamesModalImageInput.value = null;
  const modal = bootstrap.Modal.getOrCreateInstance(gamesModal);
  modal._config.backdrop = 'static'; // Prevents closing by clicking outside
  modal._config.keyboard = false; // Prevents closing by pressing Esc key
  gamesModalDisks.innerHTML = '';
  gamesModalAddDisk.removeAttribute("disabled");
  disks = 0;
  addDisk()
  modal.show()
}

async function editGame() {
  // Close Actions Modal
  actionsModalClose()

  // Init elements
  showAlert(manageAlert, 'info', "Loading game details ...")
  mode = 'edit'
  disks = 0;
  gamesModalTitle.innerHTML = 'Edit Game'
  gamesModalName.value = ''
  gamesModalImage.style.display = 'none'
  gamesModalDisks.innerHTML = '';
  gamesModalName.setAttribute("disabled", "");
  gamesModalClose.setAttribute("disabled", "");
  gamesModalCloseSubmit.setAttribute("disabled", "");
  gamesModalSaveSubmit.setAttribute("disabled", "");
  gamesModalAddDisk.setAttribute("disabled", "");
  gamesModalSelectCover.setAttribute("disabled", "");

  // Open modal
  const modal = bootstrap.Modal.getOrCreateInstance(gamesModal);
  modal._config.backdrop = 'static';
  modal._config.keyboard = false;
  modal.show()

  // Retrieve image and disks
  const query = `appProperties has { key='name' and value='${currentGameName}' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
  const response = await googleDriveAPI.listFiles(query)
  const romDisks = response.files
    .filter(obj => obj.appProperties.type === 'rom')
    .sort((a,b) => parseInt(a.appProperties.disk) - parseInt(b.appProperties.disk))
    .map(obj => ({'id': obj['id'], 'name': obj['name'], 'size': obj['size']}))

  // Save current game metadata
  currentGame = {
    'name': response.files.filter(obj => obj.appProperties.type === 'image')[0].appProperties.name,
    'image': {...response.files.filter(obj => obj.appProperties.type === 'image')[0], 'modified': false},
    'roms': romDisks,
    'save': response.files.filter(obj => obj.appProperties.type === 'save')[0] || null,
    'state': response.files.filter(obj => obj.appProperties.type === 'state')[0] || null,
  }
  
  // Get image file
  const imageFile = await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(currentGame.image.id)).blob())

  // Enable elements
  manageAlert.innerHTML = ''
  gamesModalName.removeAttribute("disabled");
  gamesModalClose.removeAttribute("disabled");
  gamesModalCloseSubmit.removeAttribute("disabled");
  gamesModalSaveSubmit.removeAttribute("disabled");
  gamesModalAddDisk.removeAttribute("disabled");
  gamesModalSelectCover.removeAttribute("disabled");
  gamesModalName.value = response.files[0].appProperties.name;

  // Init Disks
  for (let i = 0; i < romDisks.length; ++i) {
    addDisk()
    let gamesModalGameName = document.getElementById('gamesModalGameName_' + (i+1))
    gamesModalGameName.value = `${romDisks[i].name} (${calculateSize(romDisks[i].size)})`;
    gamesModalGameName.style.display = 'block';
  }

  // Init Image
  gamesModalImage.src = URL.createObjectURL(imageFile)
  gamesModalImage.style.display = 'block'
}

async function loadMoreGames() {
  gamesLoadMoreSubmit.setAttribute("disabled", "");
  gamesLoadMoreLoading.style.display = 'inline-flex';
  await loadGames(searchGame.value, nextPageToken)
  gamesLoadMoreSubmit.removeAttribute("disabled");
  gamesLoadMoreLoading.style.display = 'none';
}

function addDisk() {
  disks += 1;

  const newDiv = document.createElement('div');
  newDiv.id = `gamesModalGameDisk_${disks}`;
  newDiv.classList.add('row', 'mb-2');
  newDiv.style.backgroundColor = 'rgb(31, 33, 34)';
  newDiv.style.padding = '15px';
  newDiv.style.borderRadius = '5px';
  newDiv.style.margin = '0';
  newDiv.innerHTML = `
    <div class="col-auto d-flex align-items-center" style="font-size: 0.88rem; font-weight:500; padding:0">
      Disk ${disks}
    </div>
    <div class="col" style="padding-left:20px; padding-right:0">
      <input id="gamesModalGameName_${disks}" disabled class="form-control mb-2" style="display: none;" type="text">
      <button id="gamesModalGameSelect_${disks}" onclick="document.getElementById('gamesModalRomInput_${disks}').click()" type="button" class="btn btn-primary btn-sm my-1" style="width: 150px; height:38px; margin-right: 5px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-cloud-upload-fill" viewBox="0 0 16 16" style="margin-right:8px">
          <path fill-rule="evenodd" d="M8 0a5.53 5.53 0 0 0-3.594 1.342c-.766.66-1.321 1.52-1.464 2.383C1.266 4.095 0 5.555 0 7.318 0 9.366 1.708 11 3.781 11H7.5V5.707L5.354 7.854a.5.5 0 1 1-.708-.708l3-3a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 5.707V11h4.188C14.502 11 16 9.57 16 7.773c0-1.636-1.242-2.969-2.834-3.194C12.923 1.999 10.69 0 8 0m-.5 14.5V11h1v3.5a.5.5 0 0 1-1 0"/>
        </svg>
        Select ROM
      </button>
      <input id='gamesModalRomInput_${disks}' type='file' hidden/>
    </div>
    <button id="gamesModalGameRemove_${disks}" onclick="removeDisk(${disks})" title="Remove disk" class="col-auto d-flex align-items-center justify-content-end" style="cursor:pointer; padding-left:25px; background-color:transparent; border:none">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red" class="bi bi-x-lg" viewBox="0 0 16 16">
        <path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8z"/>
      </svg>
    </button>
  `
  gamesModalDisks.appendChild(newDiv);

  if (disks == 1) document.getElementById(`gamesModalGameRemove_${disks}`).style.visibility = 'hidden'
  else document.getElementById(`gamesModalGameRemove_${disks-1}`).style.visibility = 'hidden'
  if (disks == 5) gamesModalAddDisk.setAttribute("disabled", "");
}

function removeDisk(disk) {
  gamesModalAddDisk.removeAttribute("disabled");
  document.getElementById('gamesModalGameDisk_' + disk).remove()
  if (disk != 2) {
    document.getElementById(`gamesModalGameRemove_${disks-1}`).style.visibility = 'visible'
  }
  disks -= 1;
}

async function gamesModalSubmit() {
  // Validate inputs
  if (gamesModalName.value.trim().length == 0) {
    showAlert(manageAlert, 'warning', 'Please enter the ROM name.')
    return
  }
  if (!/^[0-9a-zA-Z\-_\: áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙ]+$/.test(gamesModalName.value.trim())) {
    showAlert(manageAlert, 'warning', 'The game name contains invalid characters.')
    return
  }
  if (mode == 'new' && gamesModalImageInput.files.length == 0) {
    showAlert(manageAlert, 'warning', 'Please upload the ROM cover image.')
    return
  }
  if (mode == 'new') {
    for (let i = 1; i <= disks; ++i) {
      let element = document.getElementById(`gamesModalRomInput_${i}`);
      if (element.files.length == 0) {
        showAlert(manageAlert, 'warning', `Please upload the ROM file for Disk ${i}.`)
        return
      }
    }
  }

  // Disable elements and apply loading effect
  gamesModalName.setAttribute("disabled", "");
  for (let i = 1; i <= disks; ++i) {
    document.getElementById(`gamesModalGameSelect_${i}`).setAttribute("disabled", "")
    document.getElementById(`gamesModalGameRemove_${i}`).setAttribute("disabled", "")
  }
  gamesModalAddDisk.setAttribute("disabled", "");
  gamesModalSelectCover.setAttribute("disabled", "");
  gamesModalSaveLoading.style.display = 'inline-flex'
  gamesModalClose.setAttribute("disabled", "");
  gamesModalCloseSubmit.setAttribute("disabled", "");
  gamesModalSaveSubmit.setAttribute("disabled", "");

  try {
    // Check mode
    if (mode == 'new') await gamesModalSubmitNew()
    else if (mode == 'edit') await gamesModalSubmitEdit()
    else if (mode == 'delete') await gamesModalDelete()

    // Show success
    showAlert(manageAlert, "success", "Game successfully stored in Google Drive.")
    await new Promise(resolve => setTimeout(resolve, 1500));
    const modal = bootstrap.Modal.getOrCreateInstance(gamesModal);
    modal.hide()
  }
  catch (error) {
    showAlert(manageAlert, 'danger', error.message)
    return
  }
  finally {
    // Enable elements and disable loading effect
    gamesModalName.removeAttribute("disabled");
    for (let i = 1; i <= disks; ++i) {
      document.getElementById(`gamesModalGameSelect_${i}`).removeAttribute("disabled")
      document.getElementById(`gamesModalGameRemove_${i}`).removeAttribute("disabled")
    }
    gamesModalAddDisk.removeAttribute("disabled");
    gamesModalSelectCover.removeAttribute("disabled");
    gamesModalSaveLoading.style.display = 'none'
    gamesModalClose.removeAttribute("disabled");
    gamesModalCloseSubmit.removeAttribute("disabled");
    gamesModalSaveSubmit.removeAttribute("disabled");
    searchGame.value = '';
  }
  // Load games
  await loadGames()
}

async function gamesModalSubmitNew() {
  // Show loading alert
  showAlert(manageAlert, 'info', "Preparing files to upload it into Google Drive...")

  // 0. Check if a game exists with the same name
  const query = `appProperties has { key='name' and value='${gamesModalName.value.trim()}' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
  const filter = await googleDriveAPI.listFiles(query, 1)
  if (filter.files.length != 0) {
    throw new Error("This game already exists.")
  }

  // 1. Upload ROM files
  for (let i = 1; i <= disks; ++i) {
    let element = document.getElementById(`gamesModalRomInput_${i}`);
    let fileName = `${gamesModalName.value.trim()}_Disk${i}${element.files[0].name.substring(element.files[0].name.lastIndexOf('.'))}.gz`;
    let fileContent = await googleDriveAPI.compress(element.files[0])
    let fileMetadata = {"name": gamesModalName.value.trim(), "type": "rom", "disk": i}
    let parentFolderName = 'Games'
    await googleDriveAPI.createFile(fileName, fileContent, fileMetadata, parentFolderName, trackUploadProgress, `Game (Disk ${i})`)
  }

  // 2. Upload image
  let fileName = gamesModalName.value.trim() + gamesModalImageInput.files[0].name.substring(gamesModalImageInput.files[0].name.lastIndexOf('.')) + '.gz';
  let fileContent = await googleDriveAPI.compress(gamesModalImageInput.files[0])
  let fileMetadata = {"name": gamesModalName.value.trim(), "type": "image"}
  let parentFolderName = 'Images'
  await googleDriveAPI.createFile(fileName, fileContent, fileMetadata, parentFolderName, trackUploadProgress, 'Image')
}

async function gamesModalSubmitEdit() {
  // Show loading alert
  showAlert(manageAlert, 'info', "Connecting to Google Drive ...")

  // Check if a game exists with the same name
  if (gamesModalName.value.trim() != currentGame.name) {
    const query = `appProperties has { key='name' and value='${gamesModalName.value.trim()}' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
    const filter = await googleDriveAPI.listFiles(query, 1)
    if (filter.files.length != 0) {
      throw new Error("This game already exists.")
    }
  }

  // Upload updated ROMS
  for (let i = 1; i <= disks; ++i) {
    let element = document.getElementById(`gamesModalRomInput_${i}`)
    if (element.files.length != 0) {
      let fileName = `${gamesModalName.value.trim()}_Disk${i}${element.files[0].name.substring(element.files[0].name.lastIndexOf('.'))}.gz`;
      let fileContent = await googleDriveAPI.compress(element.files[0])
      let fileMetadata = {"name": gamesModalName.value.trim(), "type": "rom", "disk": i}
      let parentFolderName = 'Games'
      if (i <= currentGame.roms.length) await googleDriveAPI.deleteFile(currentGame.roms[i-1].id)
      await googleDriveAPI.createFile(fileName, fileContent, fileMetadata, parentFolderName, trackUploadProgress, `Game (Disk ${i})`)
    }
  }

  // Remove ROMS / Disks deleted from user
  if (disks < currentGame.roms.length) {
    for (let i = disks; i < currentGame.roms.length; ++i) {
      await googleDriveAPI.deleteFile(currentGame.roms[i].id)
    }
  }

  // Upload updated image
  if (currentGame.image.modified) {
    let fileName = gamesModalName.value.trim() + gamesModalImageInput.files[0].name.substring(gamesModalImageInput.files[0].name.slice(0,-3).lastIndexOf('.')) + '.gz';
    let fileContent = await googleDriveAPI.compress(gamesModalImageInput.files[0])
    let fileMetadata = {"name": gamesModalName.value.trim(), "type": "image"}
    let parentFolderName = 'Images'
    await googleDriveAPI.deleteFile(currentGame.image.id)
    await googleDriveAPI.createFile(fileName, fileContent, fileMetadata, parentFolderName, trackUploadProgress, 'Image')
  }

  // Check if the name has changed
  if (gamesModalName.value.trim() != currentGame.name) {
    // Rename existing disks
    for (let i = 1; i <= disks; ++i) {
      let element = document.getElementById(`gamesModalRomInput_${i}`)
      if (element.files.length == 0) {
        let fileId = currentGame.roms[i-1].id
        let fileName = `${gamesModalName.value.trim()}_Disk${i}${currentGame.roms[i-1].name.substring(currentGame.roms[i-1].name.slice(0,-3).lastIndexOf('.'))}`;
        let fileMetadata = {"name": gamesModalName.value.trim(), "type": "rom", "disk": i}
        await googleDriveAPI.renameFile(fileId, fileName, fileMetadata)
      }
    }

    // Rename existing image
    if (!currentGame.image.modified) {
      let fileId = currentGame.image.id
      let fileName = gamesModalName.value.trim() + currentGame.image.name.substring(currentGame.image.name.slice(0,-3).lastIndexOf('.'));
      let fileMetadata = {"name": gamesModalName.value.trim(), "type": "image"}
      await googleDriveAPI.renameFile(fileId, fileName, fileMetadata)
    }

    // Rename Save Game
    if (currentGame.save != null) {
      let fileId = currentGame.save.id
      let fileName = gamesModalName.value.trim() + currentGame.save.name.substring(currentGame.save.name.slice(0,-3).lastIndexOf('.'));
      let fileMetadata = {"name": gamesModalName.value.trim(), "type": "save"}
      await googleDriveAPI.renameFile(fileId, fileName, fileMetadata)
    }

    // Rename Game State
    if (currentGame.state != null) {
      let fileId = currentGame.state.id
      let fileName = gamesModalName.value.trim() + currentGame.state.name.substring(currentGame.state.name.slice(0,-3).lastIndexOf('.'));
      let fileMetadata = {"name": gamesModalName.value.trim(), "type": "state"}
      await googleDriveAPI.renameFile(fileId, fileName, fileMetadata)
    }
  }
}

async function gamesModalDelete() {
  // Close Actions Modal
  actionsModalClose()

  // Assign game name
  confirmModalGameName.innerHTML = currentGameName;

  // Open confirm modal
  confirmAlert.innerHTML = '';
  const confirmModalObject = bootstrap.Modal.getOrCreateInstance(confirmModal);
  confirmModalObject._config.backdrop = 'static';
  confirmModalObject._config.keyboard = false;
  confirmModalObject.show()
}

function closeConfirmModal() {
  // Close confirm modal
  const confirmModalObject = bootstrap.Modal.getOrCreateInstance(confirmModal);
  confirmModalObject.hide()
}

async function gamesModalSubmitDelete() {
  // Show loading alert
  showAlert(confirmAlert, 'info', "Deleting game ...")

  // Disable elements
  confirmModalClose.setAttribute("disabled", "");
  confirmModalLoading.style.display = 'inline-flex'
  confirmModalCloseSubmit.setAttribute("disabled", "");
  confirmModalSubmit.setAttribute("disabled", "");

  try {
    // Retrieve image and disks
    const query = `appProperties has { key='name' and value='${currentGameName}' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
    const response = await googleDriveAPI.listFiles(query)
    const romDisks = response.files
      .filter(obj => obj.appProperties.type === 'rom')
      .sort((a,b) => parseInt(a.appProperties.disk) - parseInt(b.appProperties.disk))
      .map(obj => ({'id': obj['id'], 'name': obj['name'], 'size': obj['size']}))

    // Save current game metadata
    currentGame = {
      'name': response.files.filter(obj => obj.appProperties.type === 'image')[0].appProperties.name,
      'image': {...response.files.filter(obj => obj.appProperties.type === 'image')[0], 'modified': false},
      'roms': romDisks,
      'save': response.files.filter(obj => obj.appProperties.type === 'save')[0] || null,
      'state': response.files.filter(obj => obj.appProperties.type === 'state')[0] || null,
    }

    // Delete roms
    for (let i = 0; i < currentGame.roms.length; ++i) {
      await googleDriveAPI.deleteFile(currentGame.roms[i].id)
    }

    // Delete save
    if (currentGame.save != null) await googleDriveAPI.deleteFile(currentGame.save.id)

    // Delete state
    if (currentGame.state != null) await googleDriveAPI.deleteFile(currentGame.state.id)

    // Delete image
    await googleDriveAPI.deleteFile(currentGame.image.id)

    // Show success
    showAlert(confirmAlert, "success", "Game successfully removed from Google Drive.")
    await new Promise(resolve => setTimeout(resolve, 1500));
    const modal = bootstrap.Modal.getOrCreateInstance(confirmModal);
    modal.hide()

    // Load games
    await loadGames()
  }
  catch (error) {
    showAlert(confirmAlert, 'danger', error.message)
  }
  finally {
    // Enable elements
    confirmModalClose.removeAttribute("disabled");
    confirmModalLoading.style.display = 'none'
    confirmModalCloseSubmit.removeAttribute("disabled");
    confirmModalSubmit.removeAttribute("disabled");
    searchGame.value = '';
  }
}

async function trackUploadProgress(event, element) {
  showAlert(manageAlert, 'info', `Uploading ${element}. Progress: ${(Math.round(event.loaded * 100) / event.total).toFixed()}%`)
}

async function cancelUpload() {
  googleDriveAPI.abort()
}

gamesModal.addEventListener('shown.bs.modal', () => {
  gamesModalName.focus();
});

gamesModalImageInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) {
    if (mode == 'edit') currentGame.image.modified = true
    const reader = new FileReader();  
    reader.onload = function(e) {
      gamesModalImage.src = e.target.result;
      gamesModalImage.style.display = 'block';
    }
    reader.readAsDataURL(file);
  }
})

document.addEventListener("change", function(event) {
  if (event.target && event.target.id.startsWith('gamesModalRomInput')) {
    const file = event.target.files[0];
    if (file) {
      let gamesModalGameName = document.getElementById('gamesModalGameName_' + event.target.id.slice(-1))
      gamesModalGameName.value = `${file.name} (${calculateSize(file.size)})`;
      gamesModalGameName.style.display = 'block';
    }
  }
});

onLoad()