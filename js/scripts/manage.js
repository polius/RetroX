// Variables
var mode = 'new';
var disks = 1;
var nextPageToken = null;

// Get elements
const gamesGallery = document.getElementById("gamesGallery");

const manageAlert = document.getElementById("manageAlert");
const gamesModal = document.getElementById('gamesModal');
const gamesModalClose = document.getElementById('gamesModalClose');
const gamesModalAddDisk = document.getElementById('gamesModalAddDisk');
const gamesModalTitle = document.getElementById('gamesModalTitle');
const gamesModalName = document.getElementById('gamesModalName');
const gamesModalDisks = document.getElementById('gamesModalDisks');
const gamesModalPathDiv = document.getElementById('gamesModalPathDiv');
const gamesModalGameName = document.getElementById('gamesModalGameName');
const gamesModalRom = document.getElementById('gamesModalRom');
const gamesModalImage = document.getElementById('gamesModalImage');
const gamesModalImageInput = document.getElementById('gamesModalImageInput');
const gamesModalDeleteSubmit = document.getElementById('gamesModalDeleteSubmit');
const gamesModalDeleteLoading = document.getElementById('gamesModalDeleteLoading');
const gamesModalCloseSubmit = document.getElementById('gamesModalCloseSubmit');
const gamesModalSaveSubmit = document.getElementById('gamesModalSaveSubmit');
const gamesModalSaveLoading = document.getElementById('gamesModalSaveLoading');

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

  // Load games
  await loadGames()
}

function showAlert(type, message) {
  manageAlert.innerHTML = `
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

async function loadGames() {
  const div = gamesGallery.querySelector('div')

  // Show loading
  if (nextPageToken == null) {
    div.innerHTML = `
      <p style="text-align: center; margin-top:30px; margin-bottom: 0;">Loading games...</p>
      <div class="spinner-border" role="status" style="border-width: 2px">
        <span class="visually-hidden">Loading...</span>
      </div>
    `
  }

  // Get images metadata
  const images = await googleDriveAPI.getImages(nextPageToken)
  console.log(images)

  // Check if there are games to show
  if (nextPageToken == null && images.files.length == 0) {
    gamesGallery.innerHTML = `<p style="text-align: center; margin-top: 10px">There are no games in the library.</p>`
    return
  }

  // Load images metadata - first layer
  if (nextPageToken == null) div.innerHTML = ''
  images.files.forEach((element) => {
    div.innerHTML += `
      <div id="${element.id}" class="gallery-item col-xl-3 col-lg-4 col-md-6 col-10">
        <div class="d-flex justify-content-center align-items-center" style="background-color:rgba(156, 145, 129, 0.13); width: 100%; height: 200px; border-radius: 5px;">
          <div class="spinner-border" style="width: 3rem; height: 3rem; border-width: 2px;" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
        </div>
        <p style="margin-top:15px; font-weight: 600; font-size: 1.1rem;">${element.name.substring(0, element.name.lastIndexOf('.'))}</p>
      </div>
    `
  })

  // Load images content - second layer
  await Promise.all(images.files.map(async (element) => {
    const file = await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(element.id)).blob())
    const div = document.getElementById(element.id)
    div.innerHTML = `
      <img onclick="editGame('${element.id}')" src="${URL.createObjectURL(file)}" class="img-fluid img-enlarge" style="cursor:pointer; border-radius:10px" alt="">
      <p style="margin-top:15px; font-weight: 600; font-size: 1.1rem;">${element.name.substring(0, element.name.lastIndexOf('.'))}</p>
    `
  }))

  // Check if there are more games to load
  if (images.nextPageToken !== undefined) {
    nextPageToken = images.nextPageToken
    gamesLoadMoreSubmit.removeAttribute("disabled");
    gamesLoadMoreDiv.style.visibility = 'visible'
  }
  else {
    nextPageToken = null
    gamesLoadMoreDiv.style.visibility = 'hidden'
  }
}

function manageGamesClose() {
  window.location.href = `${window.location.origin}/games.html`
}

function addGame() {
  mode = 'new'
  manageAlert.innerHTML = ''
  gamesModalTitle.innerHTML = 'New Game'
  gamesModalName.value = ''
  gamesModalPathDiv.style.display = 'none'
  gamesModalImage.style.display = 'none'
  gamesModalDeleteSubmit.style.display = 'none'
  gamesModalDeleteLoading.style.display = 'none'
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

function editGame(gameID) {
  console.log(gameID)
}

async function loadMoreGames() {
  gamesLoadMoreSubmit.setAttribute("disabled", "");
  gamesLoadMoreLoading.style.display = 'inline-flex';
  await loadGames()
  gamesLoadMoreSubmit.removeAttribute("disabled");
  gamesLoadMoreLoading.style.display = 'none';
}

function addDisk() {
  disks += 1;
  gamesModalDisks.innerHTML += `
    <div id="gamesModalGameDisk_${disks}" class="row mb-2" style="background-color: rgb(31, 33, 34); padding: 15px; border-radius: 5px; margin: 0;">
      <div class="col-auto d-flex align-items-center" style="font-size: 0.88rem; font-weight:500; padding:0">
        Disk ${disks}
      </div>
      <div class="col" style="padding-left:20px; padding-right:0">
        <input id="gamesModalGameName_${disks}" disabled class="form-control mb-2" style="display: none;" type="text" placeholder="pokemon-red (16MB)">
        <button onclick="document.getElementById('gamesModalRomInput_${disks}').click()" type="button" class="btn btn-primary btn-sm my-1" style="width: 150px; height:38px; margin-right: 5px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-cloud-upload-fill" viewBox="0 0 16 16" style="margin-right:8px">
            <path fill-rule="evenodd" d="M8 0a5.53 5.53 0 0 0-3.594 1.342c-.766.66-1.321 1.52-1.464 2.383C1.266 4.095 0 5.555 0 7.318 0 9.366 1.708 11 3.781 11H7.5V5.707L5.354 7.854a.5.5 0 1 1-.708-.708l3-3a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 5.707V11h4.188C14.502 11 16 9.57 16 7.773c0-1.636-1.242-2.969-2.834-3.194C12.923 1.999 10.69 0 8 0m-.5 14.5V11h1v3.5a.5.5 0 0 1-1 0"/>
          </svg>
          Select ROM
        </button>
        <input id='gamesModalRomInput_${disks}' type='file' hidden/>
      </div>
      <div id="gamesModalGameRemove_${disks}" onclick="removeDisk(${disks})" class="col-auto d-flex align-items-center justify-content-end" style="cursor:pointer; padding-left:25px" title="Remove disk">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red" class="bi bi-x-lg" viewBox="0 0 16 16">
          <path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8z"/>
        </svg>
      </div>
    </div>`
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
    showAlert('warning', 'Please enter the ROM name.')
    return
  }
  if (!/^[0-9a-zA-Z\-_\: ]+$/.test(gamesModalName.value.trim())) {
    showAlert('warning', 'The game name contains invalid characters.')
    return
  }
  if (gamesModalImageInput.files.length == 0) {
    showAlert('warning', 'Please upload the ROM cover image.')
    return
  }
  for (let i = 1; i <= disks; ++i) {
    let element = document.getElementById(`gamesModalRomInput_${i}`);
    if (element.files.length == 0) {
      showAlert('warning', `Please upload the ROM file for Disk ${i}.`)
      return
    }
  }

  // Disable buttons and apply loading effect
  gamesModalSaveLoading.style.display = 'inline-flex'
  gamesModalClose.setAttribute("disabled", "");
  gamesModalCloseSubmit.setAttribute("disabled", "");
  gamesModalSaveSubmit.setAttribute("disabled", "");

  // Check mode
  try {
    if (mode == 'new') await gamesModalSubmitNew()
    else if (mode == 'edit') {}
    else if (mode == 'delete') {}
  } catch (error) {
    showAlert('danger', error)
  }
  finally {
    // Enable buttons and disable loading effect
    gamesModalSaveLoading.style.display = 'none'
    gamesModalClose.removeAttribute("disabled");
    gamesModalCloseSubmit.removeAttribute("disabled");
    gamesModalSaveSubmit.removeAttribute("disabled");
  }
}

async function gamesModalSubmitNew() {
  // Show loading alert
  showAlert('info', "Preparing files to upload it into Google Drive...")

  // Check if a game exists with the same name
  const query = `appProperties has { key='name' and value='${gamesModalName.value.trim()}' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
  const filter = await googleDriveAPI.listFiles(query, 1)
  console.log(filter)
  if (filter.files.length != 0) {
    showAlert('warning', "This game already exists.")
    return
  }

  // 1. Upload image
  let fileName = gamesModalName.value.trim() + gamesModalImageInput.files[0].name.substring(gamesModalImageInput.files[0].name.lastIndexOf('.'));
  let fileContent = await googleDriveAPI.compress(gamesModalImageInput.files[0])
  let parentFolderName = 'Images'
  let image_id = await googleDriveAPI.createFile(fileName, fileContent, parentFolderName, trackUploadProgress, 'Image')
  // await googleDriveAPI.addPermissions(image_id)

  // 2. Upload ROM files
  for (let i = 1; i <= disks; ++i) {
    let element = document.getElementById(`gamesModalRomInput_${i}`);
    let fileName = gamesModalName.value.trim() + element.files[0].name.substring(element.files[0].name.lastIndexOf('.'));
    let fileContent = await googleDriveAPI.compress(element.files[0])
    let parentFolderName = 'Games'
    let game_id = await googleDriveAPI.createFile(fileName, fileContent, parentFolderName, trackUploadProgress, `Game (Disk ${i})`)
    // const file = await (await googleDriveAPI.getFile(response)).blob()
    // const decompressedFile = await googleDriveAPI.decompress(file)
    // console.log(await decompressedFile.text())
  }

  // 3. Show success
  showAlert("success", "Game successfully stored in Google Drive.")
  await new Promise(resolve => setTimeout(resolve, 1500));
  const modal = bootstrap.Modal.getOrCreateInstance(gamesModal);
  modal.hide()
}

async function trackUploadProgress(event, element) {
  showAlert('info', `Uploading ${element}. Progress: ${(Math.round(event.loaded * 100) / event.total).toFixed()}%`)
  console.log(`Uploaded ${event.loaded} of ${event.total}`);
  console.log(`Progress: ${(Math.round(event.loaded * 100) / event.total).toFixed()}%`)
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

searchGame.addEventListener('input', function () {
  const searchText = this.value.toLowerCase();
  const galleryItems = document.querySelectorAll('.gallery-item');
  let itemsVisible = 0

  galleryItems.forEach(item => {
    console.log(item)
    const title = item.querySelector('p').innerText.toLowerCase();
    if (title.includes(searchText)) {
      item.style.display = 'block';
      itemsVisible += 1
    } else {
      item.style.display = 'none';
    }
  });
  gamesNumber.innerHTML = `(${itemsVisible})`
});

onLoad()