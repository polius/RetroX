function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }

  // Confirm Identity
  confirmIdentity()
}

function showAlert(type, message) {
  const callbackAlert = document.getElementById("callbackAlert");
  callbackAlert.innerHTML = `
    <div class="alert alert-${type}" role="alert">
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
    </div>
  `
}

async function confirmIdentity() {
  // Get elements
  const callbackMessage = document.getElementById("callbackMessage");
  const callbackButton = document.getElementById("callbackButton");

  // Get URL Parameters
  const queryString = window.location.search;
  const urlParams = new URLSearchParams(queryString);

  // Get Parameters
  const code = urlParams.get('code')

  // Decide which form to show
  if (!code) {
    showAlert('danger', "This URL is not valid.")
    callbackMessage.style.display = 'none';
    callbackButton.style.display = 'block';
    return
  }

  // Store Google API callback code
  try {
    const response = await fetch("https://api.retrox.app/profile/google", {
      method: "POST",
      credentials: 'include',
      body: JSON.stringify({
        mode: 'verify',
        google_client_code: code
      })
    })

    const json = await response.json()
    if (!response.ok) {
      if (response.status == 401 && !('google' in json)) await logout()
      showAlert("danger", json['message'])
      callbackButton.style.display = 'block'
    }
    else {
      showAlert("success", json['message'])
      callbackButton.style.display = 'block'
      localStorage.setItem('google_client_id', json['google_client_id'])
    }
  }
  catch (error) {
    console.log(error)
    showAlert("danger", "An error occurred. Please try again.")
  }
  finally {
    callbackMessage.style.display = 'none';
    callbackButton.style.display = 'block';
  }
}

async function callbackSubmit(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get URL Parameters
  const queryString = window.location.search;
  const urlParams = new URLSearchParams(queryString);

  // Go to the Previous Page
  window.location.href = urlParams.get('state')
}

onLoad()