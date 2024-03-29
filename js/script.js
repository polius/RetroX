import { apigateway, s3 } from "./aws.js"

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