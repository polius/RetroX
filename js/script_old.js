import { apigateway, s3 } from "./aws.js"

// Variables
var game_selected;
var games = [
    {
        name: 'Tetris',
        file: 'tetris.gb',
        image: 'tetris.png'
    },
    {
        name: 'Pokemon - Yellow',
        file: 'pokemon-yellow.gbc',
        image: 'pokemon-yellow.jpg'
    },
    {
        name: 'Pokemon - Red',
        file: 'pokemon-red.gb',
        image: 'pokemon-red.jpg'
    },
    {
        name: 'Pokemon - Blue',
        file: 'pokemon-blue.gb',
        image: 'pokemon-blue.jpg'
    },
    {
        name: 'Pokemon - Gold',
        file: 'pokemon-gold.gbc',
        image: 'pokemon-gold.jpg'
    },
    {
        name: 'Pokemon - Silver',
        file: 'pokemon-silver.gbc',
        image: 'pokemon-silver.jpg'
    },
    {
        name: 'Pokemon - Fire Red',
        file: 'pokemon-fire-red.gba',
        image: 'pokemon-fire-red.png'
    },
    {
        name: 'Pokemon - Leaf Green',
        file: 'pokemon-leaf-green.gba',
        image: 'pokemon-leaf-green.png'
    },
    {
        name: 'Super Mario Land',
        file: 'super-mario-land.gb',
        image: 'super-mario-land.png'
    },
    {
        name: 'Wario Land - Super Mario Land 3',
        file: 'wario-land.gb',
        image: 'wario-land.png'
    },
    {
        name: 'Super Mario Land 2',
        file: 'super-mario-land-2.gbc',
        image: 'super-mario-land-2.png'
    },
    {
        name: 'Super Mario Bros',
        file: 'super-mario-bros.nes',
        image: 'super-mario-bros.jpg'
    },
    {
        name: 'The Legend of Zelda - Link\'s Awakening',
        file: 'zelda-links-awakening.gbc',
        image: 'zelda-links-awakening.png'
    },
    {
        name: 'The Legend of Zelda - Oracle of Seasons',
        file: 'legend-of-zelda-the-oracle-of-seasons.gbc',
        image: 'legend-of-zelda-the-oracle-of-seasons.jpg'
    },
    {
        name: 'The Legend of Zelda - Oracle of Ages',
        file: 'legend-of-zelda-the-oracle-of-ages.gbc',
        image: 'legend-of-zelda-the-oracle-of-ages.jpg'
    },
    {
        name: 'The Legend of Zelda - A Link to the Past',
        file: 'zelda-a-link-to-the-past.gba',
        image: 'zelda-a-link-to-the-past.jpg'
    },
    {
        name: 'The Legend of Zelda - The Minish Cap',
        file: 'zelda-the-minish-cap.gba',
        image: 'zelda-the-minish-cap.png'
    },
    {
        name: 'Final Fantasy Tactics Advance',
        file: 'final-fantasy-tactics-advance.gba',
        image: 'final-fantasy-tactics-advance.jpg'
    },
    {
        name: 'The Legend of Zelda - Ocarina of Time',
        file: 'legend-of-zelda-ocarina-of-time.n64',
        image: 'legend-of-zelda-ocarina-of-time.png'
    },
    {
        name: 'Super Smash Bros',
        file: 'super-smash-bros.n64',
        image: 'super-smash-bros.jpg'
    },
    {
        name: 'Mario Kart 64',
        file: 'mario-kart-64.z64',
        image: 'mario-kart-64.jpg'
    },
    {
        name: 'Gran Turismo',
        file: 'gran-turismo.bin',
        image: 'gran-turismo.jpg'
    },
    {
        name: 'Destrega',
        file: 'destrega.bin',
        image: 'destrega.jpg'
    },
    {
        name: 'Final Fantasy IX',
        file: ['final-fantasy-ix-1.bin','final-fantasy-ix-2.bin','final-fantasy-ix-3.bin','final-fantasy-ix-4.bin'],
        image: 'final-fantasy-ix.jpg'
    }
]

// Get components
const login_button = document.getElementById("login");
const message = document.getElementById("message");
const logout_button = document.getElementById("logout");
var gamesDiv = document.getElementById("games");

// Add events
login_button.addEventListener("click", function() {
    show_login()
})

logout_button.addEventListener("click", async function() {
    show_logout()
})

async function show_logout() {
    Swal.fire({
        position: "center",
        icon: "warning",
        title: "Confirm Logout",
        text: "Are you sure you want to logout?",
        showConfirmButton: true,
    }).then((result) => {
        if (result.isConfirmed) {
            logout_submit()
        }
    })
}

async function logout_submit() {
    await apigateway.logout()
    logout_button.style.display = 'none'
    login_button.style.display = 'inline'
    message.innerHTML = ''
    Swal.fire({
        position: "center",
        icon: "success",
        title: `Successfully logged out`,
        text: "Until next time!",
        timer: 2000,
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
    })
}

async function show_login() {     
    var usernameInput, passwordInput;
    const login_form = Swal.mixin({
        title: 'Login',
        html: `
            <input type="text" id="username" class="swal2-input" placeholder="Username">
            <input type="password" id="password" class="swal2-input" placeholder="Password">
        `,
        confirmButtonText: 'Sign in',
        focusConfirm: false,
        didOpen: () => {
            const popup = Swal.getPopup()
            usernameInput = popup.querySelector('#username')
            passwordInput = popup.querySelector('#password')
            usernameInput.onkeyup = (event) => event.key === 'Enter' && Swal.clickConfirm()
            passwordInput.onkeyup = (event) => event.key === 'Enter' && Swal.clickConfirm()
        },
        preConfirm: () => {
            const username = usernameInput.value
            const password = passwordInput.value
            if (!username || !password) {
                Swal.showValidationMessage(`Please enter username and password.`)
                usernameInput.focus()
            }
            return {"username": username, "password": password}
        }
    })
    login_form.fire().then((result) => {
        if (result.isConfirmed) {
            login_submit(result.value.username, result.value.password).catch(() => login_form.fire())
        }
    });
}

async function login_submit(username, password) {
    // Login
    return new Promise(async(resolve, reject) => {
        try {
            Swal.fire({
                position: "center",
                icon: "info",
                title: "Logging in...",
                showConfirmButton: false,
                allowOutsideClick: false,
                allowEscapeKey: false,
            })
            Swal.showLoading()
            await delay(1000)
            await apigateway.login(username, password);
            Swal.fire({
                position: "center",
                icon: "success",
                title: `Welcome back, ${username}`,
                timer: 1500,
                showConfirmButton: false,
                allowOutsideClick: false,
                allowEscapeKey: false,
            })
            login_button.style.display = 'none';
            logout_button.style.display = 'inline';
            message.innerHTML = '✔️ Saves are synced in the cloud.'
            return resolve()
        } catch (error) {
            console.log(error)
            Swal.fire({
                position: "center",
                icon: "error",
                title: "Invalid credentials",
                text: "Incorrect username or password.",
                showConfirmButton: true,
                allowOutsideClick: false,
                allowEscapeKey: false,
            }).then(() => reject())
        }
    })
}

input.onchange = async () => {
    const name = input.files[0].name
    const game = new Blob([input.files[0]])
    start(name, game)
}

box.ondragover = () => box.setAttribute("drag", true);
box.ondragleave = () => box.removeAttribute("drag");

// On Load
window.addEventListener('load', async() => {
    // Fill games
    for (let game of games) {
        gamesDiv.innerHTML += `
            <!-- ${game.name} -->
            <article style="transform:translateY(-0px)" class="flex-none w-full my-4 md:m-4 md:w-240 md:min-h-240 lg:w-320 lg:min-h-320">
                <div onclick="play('${game.file}')" class="flex flex-col justify-between w-full h-full p-40 transition min-h-inherit bg-dusk md:group-hover:opacity-50 md:hover:scale-11/10x md:hover:opacity-important" style="padding:10px; border-radius:10px; cursor:pointer; background-color:rgb(37, 40, 41)">
                <img src="images/roms/${game.image}" width="300" style="margin:auto">
                </div>
            </article>
        `
    }
    // Check login
    try {
        let auth = apigateway.check_login()
        if (auth['status']) {
            login_button.style.display = 'none';
            logout_button.style.display = 'inline';
            message.innerHTML = '✔️ Saves are synced in the cloud.'
        }
    } catch (error) {
        console.log(error)
    }
});

// -----------------
// Internal Methods
// -----------------
function delay(milliseconds){
    return new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

async function compress(data) {
    // Convert the string to a byte stream.
    const stream = new Blob([data]).stream();
  
    // Create a compressed stream using the gzip algorithm.
    const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));

    // Generate a compressed response from the compressed stream.
    const compressedResponse = await new Response(compressedStream);

    // Return the compressed data as a Blob.
    return await compressedResponse.blob();
}

async function decompress(blob) {
    // Create a DecompressionStream for gzip decompression.
    let decompressionStream = new DecompressionStream("gzip");

    // Pipe the compressed blob data through the decompression stream.
    let decompressedStream = blob.stream().pipeThrough(decompressionStream);

    // Create a Response object from the decompressed stream and convert it to a Blob.
    return await new Response(decompressedStream).blob();
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
    } catch (err) {
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
        } catch (err) {
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
            } catch (err) {
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

async function play(game) {
    // Check session
    let check_login = apigateway.check_login()
    if (!check_login['status'] && check_login['was_logged']) {
        logout_button.style.display = 'none'
        login_button.style.display = 'inline'
        message.innerHTML = ''
        Swal.fire({
            position: "center",
            icon: "warning",
            title: 'The session has expired',
            confirmButtonText: 'Login'
        }).then((result) => {
            if (result.isConfirmed) show_login()
        })
        return
    }

    let game_name = game
    // If the game has multiple disks (e.g: FFIX)
    if (game.indexOf(',') > -1) {
        let disks = game.split(',')
        const inputData = {};
        disks.forEach((item, index) => {
            inputData[item] = `Disk ${index + 1}`;
        });
        const { value: disk_selected } = await Swal.fire({
            title: "Which disk you want to play?",
            input: "radio",
            inputOptions: inputData,
            inputValue: disks[0],
        });
        game = disk_selected
        game_selected = disk_selected.substring(0, disk_selected.lastIndexOf('.')).substring(0, disk_selected.lastIndexOf('-'));
        game_name = game_selected + game.substring(game.lastIndexOf('.'))
    }
    else game_selected = game.substring(0, game.lastIndexOf('.'))

    // Show loading
    Swal.fire({
        position: "center",
        icon: "info",
        title: "Downloading game",
        html: "Progress: 0%",
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
    })
    Swal.showLoading();
    await delay(1200)

    // Download game
    const response = await s3.download(`${window.location.origin}/roms/${game}.gz`, true)

    // Read the data
    let receivedLength = 0;
    let chunks = [];
    while (true) {
        const {done, value} = await response['reader'].read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        Swal.getHtmlContainer().innerHTML = `Progress: ${(Math.round(receivedLength * 100) / response['size']).toFixed(2)}%`
    }

    Swal.getHtmlContainer().innerHTML = "Game will start soon..."
    const game_file = await decompress(new Blob(chunks));

    // Start game
    start(game_name, game_file)
}

async function start(name, game) {
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

    box.remove()
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

    let check_login = apigateway.check_login()
    if (check_login['status']) {
        window.EJS_onGameStart = onGameStart
        window.EJS_onSaveState = onSaveState
        window.EJS_onLoadState = onLoadState
    }
    else Swal.close()

    script.src = "emulatorjs/loader.js";
    document.body.appendChild(script);
    landing.remove()
}

window.play = play