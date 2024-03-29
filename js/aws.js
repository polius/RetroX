// -----------
// Api Gateway
// -----------
const apiGatewayUrl = 'https://api.retrox.app'
// const apiGatewayUrl = 'https://api.alzina.dev/emu'

const register = (email, username, password) => {
    return new Promise((resolve, reject) => {
        fetch(`${apiGatewayUrl}/register/`, {
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({"email": email, "username": username, "password": password})
        })
        .then((response) => {
            if (response.ok) return response.json().then(json => {
                localStorage.setItem('auth', JSON.stringify({"username": json['username'], "expires": json['expires']}))
                resolve()
            })
            response.json().then(json => reject({"status": response.status, "message": json['message']}));
        })
        .catch(() => {
            reject({"status": 429, "message": "Too Many Requests"})
        })
    })
}

const login = (username, password) => {
    return new Promise((resolve, reject) => {
        fetch(`${apiGatewayUrl}/login/`, {
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({"username": username, "password": password})
        })
        .then((response) => {
            if (response.ok) return response.json().then(json => {
                localStorage.setItem('auth', JSON.stringify({"username": json['username'], "expires": json['expires']}))
                resolve()
            })
            response.json().then(json => reject({"status": response.status, "message": json['message']}));
        })
        .catch(() => {
            reject({"status": 429, "message": "Too Many Requests"})
        })
    })
}

const check_login = () => {
    var auth = localStorage.getItem('auth')
	if (auth == null) {
        return {"status": false, "was_logged": false}
    }
    auth = JSON.parse(auth)
    if (Math.floor(new Date().getTime() / 1000) > auth['expires']) {
        localStorage.removeItem('auth')
        return {"status": false, "was_logged": true}
    }
    return {"status": true, "username": auth['username']}
}

const logout = () => {
    return new Promise((resolve) => {
        fetch(`${apiGatewayUrl}/logout/`, {
            method: 'POST',
            credentials: 'include',
        })
        .then(() => {
            localStorage.removeItem('auth')
            resolve()
        })
        .catch(() => {
            reject({"status": 429, "message": "Too Many Requests"})
        })
    })
}

const game = (game, action) => {
    return new Promise((resolve, reject) => {
        fetch(`${apiGatewayUrl}/game/`, {
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({ game: game, action: action })
        })
        .then((response) => {
            if (response.ok) return response.json().then(json => resolve(json))
            response.json().then(json => reject({"status": response.status, "message": json['message']}));
        })
        .catch(() => {
            reject({"status": 429, "message": "Too Many Requests"})
        })
    })
}

// ---------
// Amazon S3
// ---------
const download = async(presigned_url, stream=false) => {
    if (stream) {
        const response = await fetch(presigned_url);
        const reader = response.body.getReader();
        const size = +response.headers.get('Content-Length');
        return {"reader": reader, "size": size};
    }
    else {
        return new Promise((resolve, reject) => {
            fetch(presigned_url)
            .then((response) => {
                if (response.ok) resolve(response.blob());
                else reject("The game save does not exist in the Cloud.");
            })
        })
    }
}

const upload = (presigned_url, file) => {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        Object.keys(presigned_url.fields).forEach(key => {
            formData.append(key, presigned_url.fields[key]);
        });
        formData.append("file", file);

        fetch(presigned_url.url, {
            method: 'POST',
            body: formData,
        })
        .then((response) => {
            if (response.ok) resolve()
            else reject(`${response.status}: ${response.statusText}`);
        })
    })
}

// Export an objects
export const apigateway = {
    register: register,
    login: login,
    logout: logout,
    check_login: check_login,
    game: game,
};
export const s3 = {
    download: download,
    upload: upload
};