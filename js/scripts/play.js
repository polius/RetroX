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
  // Check if gameName parameter is provided
  if (gameName == null) {
    Swal.fire({
      position: "center",
      icon: "error",
      title: "Invalid URL",
      confirmButtonText: "Go back",
      allowOutsideClick: false,
      allowEscapeKey: false,
    }).then(() => {
      window.location.href = `${window.location.origin}/games.html`
    })
    return
  }

  // Change webpage title
  document.title = `${gameName} | RetroX Emulator`

  // Show loading
  Swal.fire({
    position: "center",
    icon: "info",
    title: "Retrieving disks...",
    showConfirmButton: false,
    allowOutsideClick: false,
    allowEscapeKey: false,
  })
  Swal.showLoading();

  // Retrieve disks
  const disks = (await googleDriveAPI.getDisks(gameName)).files.map((obj) => ({"id": obj.id, "name": obj.name}))

  // Check if serch retrieved a game
  if (disks.length == 0) {
    Swal.fire({
      position: "center",
      icon: "error",
      title: "This game does not exist",
      confirmButtonText: "Go back",
      allowOutsideClick: false,
      allowEscapeKey: false,
    }).then(() => {
      window.location.href = `${window.location.origin}/games.html`
    })
    return
  }

  // Selecting disk
  let diskSelected =  disks[0]
  if (disks.length > 1) {
    const response = await Swal.fire({
      title: "Which disk you want to play?",
      input: "radio",
      inputOptions: Object.fromEntries(disks.map((item, index) => [item, `Disk ${index + 1}`])),
      inputValue: disks[0],
    });
    if (response.isConfirmed) diskSelected = response.value
    else return
  }

  if (disks.length > 1) {
    Swal.fire({
      position: "center",
      icon: "info",
      title: "Retrieving game...",
      html: "Progress: 0%",
      showConfirmButton: false,
      allowOutsideClick: false,
      allowEscapeKey: false,
    })
    Swal.showLoading();
  }
  else Swal.getTitle().innerHTML = 'Retrieving game...'

  // Retrieve rom file
  try {
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

    Swal.getHtmlContainer().innerHTML = "Starting game..."

    // Convert chunks to blob
    let blob_compressed = new Blob(chunks);

    // Decompress game
    let blob = await googleDriveAPI.decompress(blob_compressed)

    // Start game
    startGame(diskSelected.name, blob)

  }
  catch (error) {
    console.error(error)
    Swal.fire({
      position: "center",
      icon: "error",
      title: "An error occurred",
      text: error,
    })
  }
}

async function startGame(name, game) {
  const parts = name.split(".")
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

    return await new Promise(resolve => {
      const cores = {
        "Nintendo 64": "n64",
        "Nintendo Game Boy": "gb",
        "Nintendo Game Boy Advance": "gba",
        "Nintendo DS": "nds",
        "Nintendo Entertainment System": "nes",
        "Super Nintendo Entertainment System": "snes",
        "PlayStation": "psx",
        "Virtual Boy": "vb",
        "Sega Mega Drive": "segaMD",
        "Sega Master System": "segaMS",
        "Sega CD": "segaCD",
        "Atari Lynx": "lynx",
        "Sega 32X": "sega32x",
        "Atari Jaguar": "jaguar",
        "Sega Game Gear": "segaGG",
        "Sega Saturn": "segaSaturn",
        "Atari 7800": "atari7800",
        "Atari 2600": "atari2600",
        "NEC TurboGrafx-16/SuperGrafx/PC Engine": "pce",
        "NEC PC-FX": "pcfx",
        "SNK NeoGeo Pocket (Color)": "ngp",
        "Bandai WonderSwan (Color)": "ws",
        "ColecoVision": "coleco"
      }

      const button = document.createElement("button")
      const select = document.createElement("select")

      for (const type in cores) {
        const option = document.createElement("option")
        option.value = cores[type]
        option.textContent = type
        select.appendChild(option)
      }

      button.onclick = () => resolve(select[select.selectedIndex].value)
      button.textContent = "Load game"
      box.innerHTML = ""
      box.appendChild(select)
      box.appendChild(button)
    })
  })(parts.pop())

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
  window.EJS_gameUrl = game;
  window.EJS_core = core;
  window.EJS_pathtodata = "emulatorjs/";
  window.EJS_startOnLoaded = true;
  // if (window.SharedArrayBuffer) window.EJS_threads = true;

  // Override methods
  window.EJS_onGameStart = onGameStart
  window.EJS_onSaveState = onSaveState
  window.EJS_onLoadState = onLoadState

  script.src = "emulatorjs/loader.js";
  document.body.appendChild(script);
}

// --------------
// Cloud Methods
// --------------
async function onGameStart() {
  try {
    // Pause emulator and hide menu
    EJS_emulator.elements.menu.style.display = 'none';
    EJS_emulator.pause();

    // Update state
    Swal.getPopup().querySelector("#swal2-title").innerHTML = 'Loading save from Cloud'
    Swal.getHtmlContainer().innerHTML = ""
    Swal.showLoading();

    // Get Presigned Urls for Save file
    let presigned_url = await apigateway.game(game_selected, 'load_save');
    // Download and decompress save file
    let file = await decompress(await s3.download(presigned_url));
    // Load save file to emulator
    const save = new Uint8Array(await file.arrayBuffer());
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
    }).then(() => {
      EJS_emulator.elements.menu.style.display = 'flex';
      EJS_emulator.gameManager.restart();
      EJS_emulator.play();
    })
  }
  catch (err) {
    console.error(err)
    EJS_emulator.elements.menu.style.display = 'flex';
    EJS_emulator.play();
    Swal.fire({
      position: "center",
      icon: err.status == 429 ? "error" : "warning",
      title: err.status == 429 ? err.message : 'No saves found',
      text: err.status == 429 ? "Please try again in a few minutes.": '',
      timer: err.status == 429 ? 0 : 1500,
      showConfirmButton: err.status == 429,
      allowOutsideClick: false,
      allowEscapeKey: false,
    })
  }
}

async function onSaveState(e) {
  const { value: accept } = await Swal.fire({
    title: "Confirm saving game",
    text: "Existing saves will be replaced",
    icon: 'warning',
    input: "checkbox",
    inputValue: 0,
    inputPlaceholder: "I confirm",
    confirmButtonText: "Save game",
    inputValidator: (result) => {
      return !result && "You need to confirm to save the game to the cloud";
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
      })
      Swal.showLoading();
      // Get Presigned Urls for Save and State files
      const presigned_url = await apigateway.game(game_selected, 'save');
      // Get Game State
      const state_file = await compress(e.state)
      // Get Game Save
      const save_file = await compress(EJS_emulator.gameManager.getSaveFile());
      // Upload Game Save
      await s3.upload(presigned_url['save'], save_file)
      // Upload Game State
      await s3.upload(presigned_url['state'], state_file)
      // Show success notification
      Swal.fire({
        position: "center",
        icon: "success",
        title: "Game saved in Cloud",
        timer: 1500,
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
      })
    }
    catch (err) {
      let check_login = apigateway.check_login()
      if (!check_login['status']) {
        Swal.fire({
          position: "center",
          icon: "warning",
          title: 'The session has expired',
          confirmButtonText: 'Login'
        }).then((result) => {
          if (result.isConfirmed) show_login()
        })
      }
    }
  }
}

async function onLoadState() {
  // Show loading notification
  Swal.fire({
    title: "Confirm loading game",
    text: "Current game will be replaced by Cloud Save",
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: "Load game",
  }).then(async(result) => {
    if (result.isConfirmed) {
      try {
        // Show loading notification
        Swal.fire({
          position: "center",
          icon: "info",
          title: "Loading game from Cloud",
          showConfirmButton: false,
          allowOutsideClick: false,
          allowEscapeKey: false,
        })
        Swal.showLoading();
        // Get Presigned Urls for Save and State files
        let presigned_url = await apigateway.game(game_selected, 'load_state');
        let file = await decompress(await s3.download(presigned_url));
        const state = new Uint8Array(await file.arrayBuffer());
        EJS_emulator.gameManager.loadState(state);
        // Show success notification
        Swal.fire({
          position: "center",
          icon: "success",
          title: "Game loaded from Cloud",
          timer: 1500,
          showConfirmButton: false,
          allowOutsideClick: false,
          allowEscapeKey: false,
        })
      }
      catch (err) {
        let check_login = apigateway.check_login()
        if (!check_login['status']) {
          Swal.fire({
            position: "center",
            icon: "warning",
            title: 'The session has expired',
            confirmButtonText: 'Login'
          }).then((result) => {
            if (result.isConfirmed) show_login()
          })
        }
      }
    }
  });
}

onLoad()