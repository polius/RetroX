var twoFactorKey = null;
var modalMode;

function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('expires')) {
    window.location.href = `${window.location.origin}`
  }

  // Check if setup is done
  const setupButton = document.getElementById('setupButton');
  const gamesButton = document.getElementById('gamesButton');
  if (localStorage.getItem('google_client_id') == "null") setupButton.style.display = 'block';
  else gamesButton.style.display = 'block';

  // Check two factor
  const twoFactorSubmitName = document.getElementById('twoFactorSubmitName');
  const twoFactorLabel = document.getElementById('twoFactorLabel');

  twoFactorLabel.style.display = localStorage.getItem('2fa') == 'true' ? 'block' : 'none';
  twoFactorSubmitName.innerHTML = localStorage.getItem('2fa') == 'true' ? 'Disable' : 'Enable';

  // Check Google API
  const currentClientID = document.getElementById('currentClientID');
  currentClientID.value = localStorage.getItem('google_client_id') == 'null' ? 'Not yet configured.' : localStorage.getItem('google_client_id')

  // Get current email
  getEmail()
}

function showAlert(component, type, message) {
  component.innerHTML = `
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

async function getEmail() {
  // Get current email
  try {
    const response = await fetch("https://api.retrox.app/profile/email", {
      method: "GET",
      credentials: 'include',
    })

    const json = await response.json()
    if (response.ok) {
      const currentEmail = document.getElementById('currentEmail')
      currentEmail.value = json['email']
    }
    else {
      showAlert(emailAlert, "danger", "An error occurred retriving the current email.")
    }
  }
  catch (error) {
    console.error(error)
    showAlert(emailAlert, "danger", "An error occurred retriving the current email.")
  }
}

async function changeEmail(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get elements
  const newEmail = document.getElementById("newEmail");
  const submitButton = document.getElementById("submitEmail");
  const submitLoading = document.getElementById("loadingEmail");
  const emailAlert = document.getElementById("emailAlert");

  // Check if all values are filled
  if (newEmail.value.length == 0) {
    showAlert(emailAlert, "warning", "Please fill out all fields.")
    return
  }

  // Check if email is valid
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(newEmail.value)) {
    showAlert(emailAlert, "warning", "Please enter a valid email.")
    return
  }

  // Disable the submit button
  submitButton.setAttribute("disabled", "");
  submitLoading.style.display = 'inline-flex';

  // Perform the Change Email request
  const newEmailValue = newEmail.value.trim()
  try {
    const response = await fetch("https://api.retrox.app/profile/email", {
      method: "POST",
      credentials: 'include',
      body: JSON.stringify({
        email: newEmailValue,
      })
    })

    const json = await response.json()
    if (!response.ok) {
      if (response.status == 401) await logout()
      showAlert(emailAlert, "danger", json['message'])
    }
    else {
      showAlert(emailAlert, "success", json['message'])
      newEmail.value = ''
    }
  }
  catch (error) {
    console.error(error)
    showAlert(emailAlert, "danger", "An error occurred. Please try again.")
  }
  finally {
    submitButton.removeAttribute("disabled");
    submitLoading.style.display = 'none';
  }
}

async function changePassword(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get elements
  const currentPassword = document.getElementById("currentPassword");
  const newPassword = document.getElementById("newPassword");
  const confirmPassword = document.getElementById("confirmPassword");
  const submitButton = document.getElementById("submitPassword");
  const submitLoading = document.getElementById("loadingPassword");
  const passwordAlert = document.getElementById("passwordAlert");

  // Check if all values are filled
  if (currentPassword.value.length == 0 || newPassword.value.length == 0 || confirmPassword.value.length == 0) {
    showAlert(passwordAlert, "warning", "Please fill out all fields.")
    return
  }

  // Check if the passwords match
  if (newPassword.value != confirmPassword.value) {
    showAlert(passwordAlert, "warning", "The two passwords do not match.")
    newPassword.value = ''
    confirmPassword.value = ''
    newPassword.focus()
    return
  }

  // Disable the submit button
  submitButton.setAttribute("disabled", "");
  submitLoading.style.display = 'inline-flex';

  // Perform the Change Password request
  try {
    const response = await fetch("https://api.retrox.app/profile/password", {
      method: "POST",
      credentials: 'include',
      body: JSON.stringify({
        password: newPassword.value.trim(),
      })
    })

    const json = await response.json()
    if (!response.ok) {
      if (response.status == 401) await logout()
      showAlert(passwordAlert, "danger", json['message'])
    }
    else {
      showAlert(passwordAlert, "success", json['message'])
      currentPassword.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
      currentPassword.focus()
    }
  }
  catch (error) {
    console.log(error)
    showAlert(passwordAlert, "danger", "An error occurred. Please try again.")
  }
  finally {
    submitButton.removeAttribute("disabled");
    submitLoading.style.display = 'none';
  }
}

async function changeGoogleDriveAPI(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get elements
  const googleAlert = document.getElementById("googleAlert");
  const newClientID = document.getElementById("newClientID");
  const newClientSecret = document.getElementById("newClientSecret");
  const googleAPISubmit = document.getElementById("submitGoogleDriveAPI");
  const googleAPILoading = document.getElementById("loadingGoogleDriveAPI");

  // Get values
  const client_id = newClientID.value.trim()
  const client_secret = newClientSecret.value.trim()

  // Check if all values are filled
  if (client_id.length == 0 || client_secret.length == 0) {
    showAlert(googleAlert, "warning", "Please fill out all fields.")
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
      showAlert(googleAlert, "danger", json['message'])
      googleAPIClientID.value = ''
      googleAPIClientSecret.value = ''
      googleAPIClientID.focus()
    }
    else {
      showAlert(googleAlert, "success", json['message'])
      setTimeout(() => googleDriveAPI.auth(client_id), 1000)
    }
  }
  catch (error) {
    console.log(error)
    showAlert(googleAlert, "danger", "An error occurred. Please try again.")
  }
  finally {
    googleAPISubmit.removeAttribute("disabled");
    googleAPILoading.style.display = 'none';
  }
}

async function changeTwoFactor(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get components
  const twoFactorDiv = document.getElementById('twoFactorDiv');
  const qrCanvas = document.getElementById("qrCanvas");
  const twoFactorCode = document.getElementById('twoFactorCode');
  const submitButton = document.getElementById('twoFactorSubmit');
  const submitLoading = document.getElementById('twoFactorLoading');
  const twoFactorLabel = document.getElementById('twoFactorLabel');
  const twoFactorSubmitName = document.getElementById('twoFactorSubmitName');
  const twoFactorAlert = document.getElementById("twoFactorAlert");

  // Disable two-factor
  if (localStorage.getItem('2fa') == 'true') {
    // Get components
    const modal = new bootstrap.Modal(document.getElementById('modal'), {
      backdrop: 'static',
      keyboard: false
    })
    const modalTitle = document.getElementById('modalTitle')
    const modalBody = document.getElementById('modalBody')

    // Set values
    modalMode = '2fa'
    modalTitle.innerHTML = 'Disable Two-Factor Authentication'
    modalBody.innerHTML = 'Are you sure you want to disable it?'
    modal.show()
  }
  else {
    // Disable the submit button
    submitButton.setAttribute("disabled", "");
    submitLoading.style.display = 'inline-flex';

    // Enable two-factor - Step 1/2
    if (twoFactorKey == null) {
      try {
        const response = await fetch("https://api.retrox.app/profile/2fa", {
          method: "POST",
          credentials: 'include',
          body: JSON.stringify({
            enable: true
          })
        })

        const json = await response.json()
        if (!response.ok) {
          if (response.status == 401) await logout()
          showAlert(twoFactorAlert, "danger", json['message'])
        }
        else {
          showAlert(twoFactorAlert, "success", json['message'])
          twoFactorKey = json['2fa_key']
          twoFactorDiv.style.display = 'block'
          twoFactorSubmitName.innerHTML = 'Submit'
          twoFactorCode.value = ''
          twoFactorCode.focus()
          qrCanvas.title = `QR Key: ${json['2fa_key']}`
          QRCode.toCanvas(
            qrCanvas,
            json['2fa_uri'],
            { errorCorrectionLevel: "H" },
            function (error) {
              if (error) console.error(error);
            }
          )
        }
      }
      catch (error) {
        console.log(error)
        showAlert(twoFactorAlert, "danger", "An error occurred. Please try again.")
      }
      finally {
        submitButton.removeAttribute("disabled");
        submitLoading.style.display = 'none';
      }
    }
    // Enable two-factor - Step 2/2
    else if (twoFactorKey != null) {
      // Check if all values are filled
      if (twoFactorCode.value.length == 0) {
        showAlert(twoFactorAlert, "warning", "The Two-Factor code is empty.")
        submitButton.removeAttribute("disabled");
        submitLoading.style.display = 'none';
        return
      }
      try {
        const response = await fetch("https://api.retrox.app/profile/2fa", {
          method: "POST",
          credentials: 'include',
          body: JSON.stringify({
            enable: true,
            key: twoFactorKey,
            code: twoFactorCode.value.trim()
          })
        })

        const json = await response.json()
        if (!response.ok) {
          if (response.status == 401) await logout()
          showAlert(twoFactorAlert, "danger", json['message'])
        }
        else {
          showAlert(twoFactorAlert, "success", json['message'])
          twoFactorKey = null
          twoFactorDiv.style.display = 'none'
          twoFactorSubmitName.innerHTML = 'Disable'
          twoFactorCode.value = ''
          twoFactorLabel.style.display = 'block';
          localStorage.setItem('2fa', 'true')
        }
      }
      catch (error) {
        console.log(error)
        showAlert(twoFactorAlert, "danger", "An error occurred. Please try again.")
      }
      finally {
        submitButton.removeAttribute("disabled");
        submitLoading.style.display = 'none';
      }
    }
  }
}

async function disable2FASubmit() {
  // Get components
  const twoFactorLabel = document.getElementById('twoFactorLabel');
  const twoFactorSubmitName = document.getElementById('twoFactorSubmitName');
  const twoFactorAlert = document.getElementById("twoFactorAlert");
  const modalAlert = document.getElementById('modalAlert');
  const modal = bootstrap.Modal.getInstance(document.getElementById('modal'));

  // Disable 2FA
  try {
    const response = await fetch("https://api.retrox.app/profile/2fa", {
      method: "POST",
      credentials: 'include',
      body: JSON.stringify({
        enable: false
      })
    })

    const json = await response.json()
    if (!response.ok) {
      if (response.status == 401) await logout()
      showAlert(modalAlert, "danger", json['message'])
    }
    else {
      showAlert(twoFactorAlert, "success", json['message'])
      twoFactorSubmitName.innerHTML = 'Enable'
      twoFactorLabel.style.display = 'none'
      localStorage.setItem('2fa', 'false')
      modal.hide()
    }
  }
  catch (error) {
    console.log(error)
    showAlert(modalAlert, "danger", "An error occurred. Please try again.")
  }
}

async function deleteAccount(event) {
  // Prevent page to refresh
  event.preventDefault();

  // Get components
  const modal = new bootstrap.Modal(document.getElementById('modal'), {
    backdrop: 'static',
    keyboard: false
  })
  const modalTitle = document.getElementById('modalTitle')
  const modalBody = document.getElementById('modalBody')

  // Set values
  modalMode = 'delete'
  modalTitle.innerHTML = 'Delete account'
  modalBody.innerHTML = 'Are you sure you want to delete your account?'
  modal.show()
}

async function deleteAccountSubmit() {
  // Get components
  const modalAlert = document.getElementById('modalAlert');

  // Perform the Change Password request
  try {
    const response = await fetch("https://api.retrox.app/profile/delete", {
      method: "POST",
      credentials: 'include',
    })
    const json = await response.json()
    if (!response.ok) showAlert(modalAlert, "danger", json['message'])
    else {
      showAlert(modalAlert, "success", json['message'])

      // Perform the Logout request
      await fetch("https://api.retrox.app/logout/", { 
        method: "POST",
        credentials: 'include',
      })

      // Clean local storage
      localStorage.removeItem('token')
      localStorage.removeItem('2fa')
      localStorage.removeItem('expires')
      localStorage.removeItem('username')
      localStorage.removeItem('remember')
      localStorage.removeItem('google_client_id')

      return await new Promise(resolve => {
        setTimeout(() => {
          window.location.href = `${window.location.origin}`
          resolve()
        }, 1500)
      })
    }
  }
  catch (error) {
    console.log(error)
    showAlert(passwordAlert, "danger", "An error occurred. Please try again.")
  }
}

async function modalConfirm() {
  // Get components
  const closeModal = document.getElementById('closeModal');
  const cancelModal = document.getElementById('cancelModal');
  const submitButton = document.getElementById('modalSubmit');
  const submitLoading = document.getElementById('modalLoading');

  // Disable the submit button
  closeModal.setAttribute("disabled", "");
  cancelModal.setAttribute("disabled", "");
  submitButton.setAttribute("disabled", "");
  submitLoading.style.display = 'inline-flex';

  if (modalMode == 'delete') await deleteAccountSubmit()
  else if (modalMode == '2fa') await disable2FASubmit()

  // Enable submit button again
  submitButton.removeAttribute("disabled");
  closeModal.removeAttribute("disabled");
  cancelModal.removeAttribute("disabled");
  submitLoading.style.display = 'none';
}

onLoad()