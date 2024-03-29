function turnstileCallback(token) {
  const submitButton = document.getElementById("submit");
  // submitButton.setAttribute("disabled", "");
  submitButton.removeAttribute("disabled");
}

const register = () => {
  // Get data
  const email = document.getElementById("email");
  const username = document.getElementById("username");
  const password = document.getElementById("password");
  const repeatPassword = document.getElementById("repeatPassword");
  const registerModal = new bootstrap.Modal(document.getElementById('registerModal'));
  const registerModalError = document.getElementById("registerModalError");
  const cfToken = turnstile.getResponse();

  // Check if token is valid
  // if (cf_token === undefined) {
  //   registerModalError.innerText = "Confirm the Cloudflare Captcha."
  //   registerModal.show();
  // }

  // Check if all values are filled
  if (email.value.length == 0 || username.value.length == 0 || password.value.length == 0 || repeatPassword.value.length == 0) {
    registerModalError.innerText = "Please fill all fields."
    registerModal.show();
  }

  // Check if the passwords match
  if (password.value != repeatPassword.value) {
    registerModalError.innerText = "The two passwords does not match. Please enter again the password."
    password.value = ''
    repeatPassword.value = ''
    registerModal.show();
  }

  fetch("https://api.retrox.app/register", {
    method: "POST",
    body: JSON.stringify({
      email: email,
      username: username,
      password: password,
    }),
  })
  .then(response => {
    if (!response.ok) {
      throw new Error('network returns error');
    }
    return response.json();
  })
  .then((response) => {

  })
  .catch((error) => {
      // Handle error
      console.log("error ", error);
  });

  console.log("hi")
  const token = turnstile.getResponse()
  console.log(token)
  if (token === undefined) console.log("KO!")
}

// const register = (email, username, password) => {
//     return new Promise((resolve, reject) => {
//         fetch(`${apiGatewayUrl}/register/`, {
//             method: 'POST',
//             credentials: 'include',
//             body: JSON.stringify({"email": email, "username": username, "password": password})
//         })
//         .then((response) => {
//             if (response.ok) return response.json().then(json => {
//                 localStorage.setItem('auth', JSON.stringify({"username": json['username'], "expires": json['expires']}))
//                 resolve()
//             })
//             response.json().then(json => reject({"status": response.status, "message": json['message']}));
//         })
//         .catch(() => {
//             reject({"status": 429, "message": "Too Many Requests"})
//         })
//     })
// }


// await apigateway.login(username, password);