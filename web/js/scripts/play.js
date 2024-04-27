async function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }

  // Check URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  await playGame(urlParams.get('game'))
}

async function playGame(gameName) {
  try {
    // Check if gameName parameter is provided
    if (gameName == null) {
      Swal.fire({
        position: "center",
        icon: "error",
        title: "Invalid URL",
        confirmButtonText: "Go back",
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      }).then(() => {
        window.location.href = `${window.location.origin}/games${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`
      })
      return
    }

    // Change webpage title
    document.title = `${gameName} | RetroX Emulator`

    // Show loading
    Swal.fire({
      position: "center",
      icon: "info",
      title: "Fetching game information",
      showConfirmButton: false,
      allowOutsideClick: false,
      allowEscapeKey: false,
      target: document.fullscreenElement || document.body,
    })
    Swal.showLoading();

    // Retrieve game
    const game = await googleDriveAPI.getGame(gameName)
    const disks = game.files.filter(obj => obj.appProperties.type == 'rom').map(obj => ({"id": obj.id, "name": obj.name}))
    const saveGame = game.files.filter(obj => obj.appProperties.type == 'save')

    // Check if serch retrieved a game
    if (disks.length == 0) {
      Swal.fire({
        position: "center",
        icon: "error",
        title: "This game does not exist",
        confirmButtonText: "Go back",
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      }).then(() => {
        window.location.href = `${window.location.origin}/games${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`
      })
      return
    }

    // Selecting disk
    let diskSelected = disks[0]
    if (disks.length > 1) {
      const response = await Swal.fire({
        title: "Which disk you want to play?",
        input: "radio",
        inputOptions: Object.fromEntries(disks.map((item, index) => [item.id, `Disk ${index + 1}`])),
        inputValue: diskSelected.id,
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      });
      diskSelected = disks.filter(obj => obj.id == response.value)[0]
    }

    if (disks.length > 1) {
      Swal.fire({
        position: "center",
        icon: "info",
        title: "Retrieving game",
        html: "Progress: 0%",
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      })
      Swal.showLoading();
    }
    else Swal.getTitle().innerHTML = 'Retrieving game'

    // Retrieve rom file
    const response = await googleDriveAPI.getFile(diskSelected.id)
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
      Swal.getHtmlContainer().innerHTML = `Progress: ${(Math.round(receivedLength * 100) / contentLength).toFixed(2)}%`
    }

    Swal.getHtmlContainer().innerHTML = "Starting game"

    // Convert chunks to blob
    let blob_compressed = new Blob(chunks);

    // Decompress game
    let blob = await googleDriveAPI.decompress(blob_compressed)

    // Start game
    await startGame(gameName, diskSelected.name.slice(0, -3), blob, saveGame)
  }
  catch (error) {
    let isError = await handleCatch(false);
    if (!isError) {
      Swal.fire({
        position: "center",
        icon: "error",
        title: "An error occurred",
        confirmButtonText: "Go back",
        text: error.message,
        showConfirmButton: true,
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      }).then(() => window.location.href = `${window.location.origin}/games${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`)
    }
  }
}

async function startGame(gameName, fileName, fileData, saveGame) {
  const parts = fileName.split(".")
  const core = await (async (ext) => {
    if (["fds", "nes", "unif", "unf"].includes(ext)) return "nes"
    if (["smc", "fig", "sfc", "gd3", "gd7", "dx2", "bsx", "swc"].includes(ext)) return "snes"
    if (["z64", "n64"].includes(ext)) return "n64"
    if (["pce"].includes(ext)) return "pce"
    if (["ngp", "ngc"].includes(ext)) return "ngp"
    if (["ws", "wsc"].includes(ext)) return "ws"
    if (["col", "cv"].includes(ext)) return "coleco"
    if (["gbc"].includes(ext)) return "gb"
    if (["bin"].includes(ext)) return "psx"
    if (["nds", "gba", "gb", "z64", "n64"].includes(ext)) return ext
  })(parts.pop())

  if (core === undefined) throw new Error("This file can not be loaded.")

  const div = document.createElement("div")
  const sub = document.createElement("div")
  const script = document.createElement("script")

  sub.id = "game"
  div.id = "display"
  div.style.position = "absolute"
  div.style.width = "100%"
  div.style.height = "100%"

  div.appendChild(sub)
  document.body.appendChild(div)

  window.EJS_player = "#game";
  window.EJS_gameName = parts.shift();
  window.EJS_biosUrl = "";
  window.EJS_gameUrl = fileData;
  window.EJS_core = core;
  window.EJS_pathtodata = "emulatorjs/";
  window.EJS_startOnLoaded = true;
  // if (window.SharedArrayBuffer) window.EJS_threads = true;

  // Override methods
  window.EJS_onGameStart = () => onGameStart(saveGame)
  window.EJS_onSaveState = (e) => onSaveState(gameName, e)
  window.EJS_onLoadState = () => onLoadState(gameName)

  script.src = "emulatorjs/loader.js";
  document.body.appendChild(script);
}

// --------------
// Cloud Methods
// --------------
async function onGameStart(saveGame) {
  try {
    // Check if exists a save
    if (saveGame.length == 0) {
      Swal.fire({
        position: "center",
        icon: "warning",
        title: 'No saves found',
        timer: 1500,
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      })
      return
    }

    // Pause emulator and hide menu
    EJS_emulator.elements.menu.style.display = 'none';
    EJS_emulator.pause();

    // Update state
    Swal.getPopup().querySelector("#swal2-title").innerHTML = 'Loading save from Cloud'
    Swal.getHtmlContainer().innerHTML = ""
    Swal.showLoading();

    // Get save game
    const saveFile = await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(saveGame[0].id)).blob())

    // Load save file to emulator
    const save = new Uint8Array(await saveFile.arrayBuffer());
    const path = EJS_emulator.gameManager.getSaveFilePath();
    const paths = path.split("/");
    let cp = "";
    for (let i=0; i<paths.length-1; i++) {
      if (paths[i] === "") continue;
      cp += "/"+paths[i];
      if (!FS.analyzePath(cp).exists) FS.mkdir(cp);
    }
    if (FS.analyzePath(path).exists) FS.unlink(path);
    FS.writeFile(path, save);
    EJS_emulator.gameManager.loadSaveFiles();
    // Show success notification
    Swal.fire({
      position: "center",
      icon: "success",
      title: "Save loaded from Cloud",
      timer: 1500,
      showConfirmButton: false,
      allowOutsideClick: false,
      allowEscapeKey: false,
      target: document.fullscreenElement || document.body,
    }).then(() => {
      EJS_emulator.elements.menu.style.display = 'flex';
      EJS_emulator.gameManager.restart();
      EJS_emulator.play();
    })
  }
  catch (err) {
    EJS_emulator.elements.menu.style.display = 'flex';
    EJS_emulator.play();
    Swal.fire({
      position: "center",
      icon: "error",
      title: "An error occurred retrieving the save game.",
      text: "Please try again in a few minutes.",
      showConfirmButton: true,
      allowOutsideClick: false,
      allowEscapeKey: false,
      target: document.fullscreenElement || document.body,
    })
  }
}

async function onSaveState(gameName, e) {
  const { value: accept } = await Swal.fire({
    title: "Confirm saving game",
    text: "Existing saves will be replaced",
    icon: 'warning',
    input: "checkbox",
    inputValue: 0,
    inputPlaceholder: "I confirm",
    confirmButtonText: "Save game",
    target: document.fullscreenElement || document.body,
    inputValidator: (result) => {
      return !result && "Please confirm to save the game to the cloud.";
    }
  });
  if (accept) {
    try {
      // Show loading notification
      Swal.fire({
        position: "center",
        icon: "info",
        title: "Saving game in Cloud",
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      })
      Swal.showLoading();

      // Retrieve game metadata
      const gameMetadata = (await googleDriveAPI.getGame(gameName)).files.filter(obj => ['state','save'].includes(obj.appProperties.type))

      // Delete save and state files
      for (let i = 0; i < gameMetadata.length; ++i) {
        await googleDriveAPI.deleteFile(gameMetadata[i].id)
      }

      // Store save
      let saveName = `${gameName}.save.gz`
      let saveContent = await googleDriveAPI.compress(EJS_emulator.gameManager.getSaveFile())
      let saveMetadata = {"name": gameName, "type": "save"}
      let saveFolder = 'Saves'
      await googleDriveAPI.createFile(saveName, saveContent, saveMetadata, saveFolder)

      // Store state
      let stateName = `${gameName}.state.gz`
      let stateContent = await googleDriveAPI.compress(e.state)
      let stateMetadata = {"name": gameName, "type": "state"}
      let stateFolder = 'States'
      await googleDriveAPI.createFile(stateName, stateContent, stateMetadata, stateFolder)

      // Show success notification
      Swal.fire({
        position: "center",
        icon: "success",
        title: "Game saved in Cloud",
        timer: 1500,
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        target: document.fullscreenElement || document.body,
      })
    }
    catch (error) {
      console.error(error)
      let isError = await handleCatch(true)
      if (!isError) {
        Swal.fire({
          position: "center",
          icon: "error",
          title: "An error occurred retrieving the save game.",
          text: "Please try again in a few minutes.",
          showConfirmButton: true,
          allowOutsideClick: false,
          allowEscapeKey: false,
          target: document.fullscreenElement || document.body,
        })
      }
    }
  }
}

async function onLoadState(gameName) {
  // Show loading notification
  Swal.fire({
    title: "Confirm loading game",
    text: "Current game will be replaced by Cloud Save",
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: "Load game",
    target: document.fullscreenElement || document.body,
  }).then(async(result) => {
    if (result.isConfirmed) {
      try {
        // Show loading notification
        Swal.fire({
          position: "center",
          icon: "info",
          title: "Loading save from Cloud",
          showConfirmButton: false,
          allowOutsideClick: false,
          allowEscapeKey: false,
          target: document.fullscreenElement || document.body,
        })
        Swal.showLoading();

        // Retrieve game metadata
        const gameStateMetadata = (await googleDriveAPI.getGame(gameName)).files.filter(obj => obj.appProperties.type == 'state')

        // Check if exists a game save
        if (gameStateMetadata.length == 0) {
          Swal.fire({
            position: "center",
            icon: "error",
            title: 'No Cloud saves found',
            showConfirmButton: true,
            allowOutsideClick: false,
            allowEscapeKey: false,
            target: document.fullscreenElement || document.body,
          })
          return
        }

        // Retrieve game state
        const gameState = new Uint8Array(await (await googleDriveAPI.decompress(await (await googleDriveAPI.getFile(gameStateMetadata[0].id)).blob())).arrayBuffer())
        EJS_emulator.gameManager.loadState(gameState);

        // Show success notification
        Swal.fire({
          position: "center",
          icon: "success",
          title: "Game loaded from Cloud",
          timer: 1500,
          showConfirmButton: false,
          allowOutsideClick: false,
          allowEscapeKey: false,
          target: document.fullscreenElement || document.body,
        })
      }
      catch (error) {
        console.error(error)
        let isError = await handleCatch(true)
        if (!isError) {
          Swal.fire({
            position: "center",
            icon: "error",
            title: "An error occurred retrieving the save game.",
            text: "Please try again in a few minutes.",
            showConfirmButton: true,
            allowOutsideClick: false,
            allowEscapeKey: false,
            target: document.fullscreenElement || document.body,
          })
        }
      }
    }
  });
}

async function handleCatch(newTab) {
  // Check session
  if (!isLogged()) {
    Swal.fire({
      position: "center",
      icon: "error",
      title: "An error occurred",
      text: "The session has expired. Please log in again.",
      confirmButtonText: "Login",
      showConfirmButton: true,
      target: document.fullscreenElement || document.body,
    }).then(() => {
      if (newTab) window.open(`${window.location.origin}/login${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`, '_blank');
      else window.location.href = `${window.location.origin}/login${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`
    })
    return true
  }
  // Check if Google Credentials have expired
  try {
    await googleDriveAPI.getToken()
  }
  catch (err) {
    Swal.fire({
      position: "center",
      icon: "error",
      title: "An error occurred",
      text: err.message,
      confirmButtonText: "Login to Google Drive",
      showConfirmButton: true,
      target: document.fullscreenElement || document.body,
    }).then(async () => {
      await googleDriveAPI.auth(localStorage.getItem('google_client_id'), newTab)
    })
    return true
  }
  return false
}

onLoad()