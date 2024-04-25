function onLoad() {
  // Check if user is not logged in or if has already finished the setup
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }
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

async function saveGoogleAPICredentials(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get elements
  const googleAPIClientID = document.getElementById("googleAPIClientID");
  const googleAPIClientSecret = document.getElementById("googleAPIClientSecret");
  const googleAPISubmit = document.getElementById("googleAPISubmit");
  const googleAPILoading = document.getElementById("googleAPILoading");

  // Get values
  const client_id = googleAPIClientID.value.trim()
  const client_secret = googleAPIClientSecret.value.trim()

  // Check if all values are filled
  if (googleAPIClientID.value.trim().length == 0 || googleAPIClientSecret.value.trim().length == 0) {
    showAlert(passwordAlert, "warning", "Please fill out all fields.")
    return
  }

  // Disable the submit button
  googleAPISubmit.setAttribute("disabled", "");
  googleAPILoading.style.display = 'inline-flex';

  // Store the client_id and client_secret
  try {
    const response = await fetch("https://api.retrox.app/profile/google", {
      method: "POST",
      credentials: 'include',
      body: JSON.stringify({
        mode: 'init',
        google_client_id: client_id,
        google_client_secret: client_secret
      })
    })

    const json = await response.json()
    if (!response.ok) {
      if (response.status == 401) await logout()
      showAlert("danger", json['message'])
      googleAPIClientID.value = ''
      googleAPIClientSecret.value = ''
      googleAPIClientID.focus()
    }
    else {
      showAlert("success", json['message'])
      setTimeout(() => googleDriveAPI.auth(client_id), 1000)
    }
  }
  catch (error) {
    console.log(error)
    showAlert("danger", "An error occurred. Please try again.")
  }
  finally {
    googleAPISubmit.removeAttribute("disabled");
    googleAPILoading.style.display = 'none';
  }
}

onLoad()