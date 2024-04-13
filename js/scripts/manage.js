// Variables
var disks = 1;

// Get elements
const gamesModal = document.getElementById('gamesModal');
const gamesModalAddDisk = document.getElementById('gamesModalAddDisk');
const gamesModalTitle = document.getElementById('gamesModalTitle');
const gamesModalName = document.getElementById('gamesModalName');
const gamesModalDisks = document.getElementById('gamesModalDisks');
const gamesModalPathDiv = document.getElementById('gamesModalPathDiv');
const gamesModalGameName = document.getElementById('gamesModalGameName');
const gamesModalRom = document.getElementById('gamesModalRom');
const gamesModalImage = document.getElementById('gamesModalImage');
const gamesModalDelete = document.getElementById('gamesModalDelete');
const searchGame = document.getElementById('searchGame');

const gamesManageList = document.getElementById('gamesManageList');
const gamesManageSubmitButton = document.getElementById('gamesManageSubmitButton');
const gamesManageCloseButton = document.getElementById('gamesManageCloseButton');
const gamesManageAddButton = document.getElementById('gamesManageAddButton');

function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }
}

function showAlert(type, message) {
  const manageAlert = document.getElementById("manageAlert");
  manageAlert.innerHTML = `
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

function manageGamesClose() {
  window.location.href = `${window.location.origin}/games.html`
}

function addGame() {
  gamesModalTitle.innerHTML = 'New Game'
  gamesModalPathDiv.style.display = 'none'
  gamesModalImage.style.display = 'none'
  gamesModalDelete.style.display = 'none'
  const modal = bootstrap.Modal.getOrCreateInstance(gamesModal);
  modal._config.backdrop = 'static'; // Prevents closing by clicking outside
  modal._config.keyboard = false; // Prevents closing by pressing Esc key
  gamesModalDisks.innerHTML = '';
  gamesModalAddDisk.removeAttribute("disabled");
  disks = 0;
  addDisk()
  modal.show()
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
      </div>
      <div id="gamesModalGameRemove_${disks}" onclick="removeDisk(${disks})" class="col-auto d-flex align-items-center justify-content-end" style="cursor:pointer; padding-left:25px" title="Remove disk">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="red" class="bi bi-x-lg" viewBox="0 0 16 16">
          <path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8z"/>
        </svg>
      </div>
      <input id='gamesModalRomInput_${disks}' type='file' hidden/>
    </div>`
  if (disks == 1)  document.getElementById(`gamesModalGameRemove_${disks}`).style.visibility = 'hidden'
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

onLoad()

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
      console.log(file)
      let gamesModalGameName = document.getElementById('gamesModalGameName_' + event.target.id.slice(-1))
      gamesModalGameName.value = `${file.name} (${calculateSize(file.size)})`;
      gamesModalGameName.style.display = 'block';
    }
  }
});

searchGame.addEventListener('input', function () {
  const searchText = this.value.toLowerCase();
  const galleryItems = document.querySelectorAll('.gallery-item');

  galleryItems.forEach(item => {
      const title = item.querySelector('p').innerText.toLowerCase();
      const image = item.querySelector('img');

      if (title.includes(searchText)) {
          item.style.display = 'block';
      } else {
          item.style.display = 'none';
      }
  });
});