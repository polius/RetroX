// Variables
var nextPageToken = undefined;

// Get elements
const gamesNumber = document.getElementById("gamesNumber")
const gamesManageSubmitButton = document.getElementById("gamesManageSubmitButton")
const searchGame = document.getElementById("searchGame")
const gamesListDiv = document.getElementById("gamesListDiv")
const gamesGallery = document.getElementById("gamesGallery")
const gamesLoadMoreDiv = document.getElementById("gamesLoadMoreDiv")
const gamesLoadMoreSubmit = document.getElementById("gamesLoadMoreSubmit")
const gamesLoadMoreLoading = document.getElementById("gamesLoadMoreLoading")

async function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }

  // Check if Google Drive API is setup
  if (localStorage.getItem('google_client_id') == null) {
    window.location.href = `${window.location.origin}/setup.html`
    gamesSetupDiv.style.display = 'block';
  }
  else {
    gamesManageSubmitButton.removeAttribute("disabled");
  }

  // Load games
  await loadGames()
}

function showAlert(type, message) {
  const googleAPIAlert = document.getElementById("googleAPIAlert");
  googleAPIAlert.innerHTML = `
    <div class="alert alert-${type} alert-dismissible" role="alert">
      <div style="text-align:left">
        ${type == 'success'
        ? 
          `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-check-circle-fill" viewBox="0 0 16 16" style="margin-bottom:3px; margin-right:3px">
            <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/>
          </svg>`
        :
          `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-exclamation-triangle-fill" viewBox="0 0 16 16" style="margin-bottom:3px; margin-right:3px">
            <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"/>
          </svg>`
        }
        ${message}
      </div>
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    </div>
  `
}

function manageGames() {
  window.location.href = `${window.location.origin}/manage.html`
}

async function loadGames(name, nextToken) {
  const div = gamesGallery.querySelector('div')

  // Show loading
  if (nextToken === undefined) {
    div.innerHTML = `
      <p style="text-align: center; margin-top:30px; margin-bottom: 0;">Loading games...</p>
      <div class="spinner-border" role="status" style="border-width: 2px">
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
    if (name === undefined) div.innerHTML = `<p style="text-align: center; margin-top: 40px">There are no games in the library. To get started, click the <b>Manage</b> button to start adding games.</p>`
    else div.innerHTML = `<p style="text-align: center; margin-top: 40px">There are no games containing this name.</p>`
    return
  }

  // Load images metadata - first layer
  if (nextToken === undefined) div.innerHTML = ''
  images.files.forEach((element) => {
    const gameName = element.name.substring(0, element.name.lastIndexOf('.'))
    div.innerHTML += `
      <div onclick="playGame('${gameName}')" id="${element.id}" class="gallery-item col-xl-3 col-lg-4 col-md-6 col-10">
        <div class="d-flex justify-content-center align-items-center" style="background-color:rgba(156, 145, 129, 0.13); width: 100%; height: 200px; border-radius: 5px; cursor:pointer;">
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
    await (await googleDriveAPI.getFile(element.id)).blob()
    await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(element.id)).blob())
    const file = await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(element.id)).blob())
    const gameName = element.name.substring(0, element.name.lastIndexOf('.'))
    const div = document.getElementById(element.id)
    div.innerHTML = `
      <img src="${URL.createObjectURL(file)}" class="img-fluid img-enlarge" style="cursor:pointer; border-radius:10px" alt="">
      <p style="margin-top:15px; font-weight: 600; font-size: 1.1rem;">${gameName}</p>
    `
  }))

  // Check if there are more games to load
  if (images.nextPageToken !== undefined) {
    nextPageToken = images.nextPageToken
    gamesLoadMoreSubmit.removeAttribute("disabled");
    gamesLoadMoreDiv.style.visibility = 'visible'
  }
  else {
    nextPageToken = undefined
    gamesLoadMoreDiv.style.visibility = 'hidden'
  }
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
  googleDriveAPI.abort()
  await loadGames(searchGame.value)
}

async function loadMoreGames() {
  gamesLoadMoreSubmit.setAttribute("disabled", "");
  gamesLoadMoreLoading.style.display = 'inline-flex';
  await loadGames(searchGame.value, nextPageToken)
  gamesLoadMoreSubmit.removeAttribute("disabled");
  gamesLoadMoreLoading.style.display = 'none';
}

function playGame(gameName) {
  // Open "play.html?game={gameName}" in same page
  console.log(gameName)
  window.location.href = `${window.location.origin}/play.html?game=${encodeURIComponent(gameName)}`
}

onLoad()