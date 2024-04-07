var twoFactorStep = 1
var modalMode;

function onLoad() {
  // Check if user is not logged in
  if (!localStorage.getItem('token')) {
    window.location.href = `${window.location.origin}`
  }

  // Add current email
  const currentEmail = document.getElementById('currentEmail')
  currentEmail.value = localStorage.getItem('email')

  // Check two factor
  const twoFactorSubmitName = document.getElementById('twoFactorSubmitName');
  twoFactorSubmitName.innerHTML = localStorage.getItem('2fa') == 'true' ? 'Disable' : 'Enable';
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
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: newEmailValue,
      })
    })

    const json = await response.json()
    if (!response.ok) {
      showAlert(emailAlert, "danger", json['message'])
    }
    else {
      showAlert(emailAlert, "success", json['message'])
      newEmail.value = ''
    }
  }
  catch (error) {
    console.log(error)
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
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        password: newPassword.value.trim(),
      })
    })

    const json = await response.json()
    if (!response.ok) {
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
    modalBody.innerHTML = 'Are you sure you want to disable the Two-Factor Authentication?'
    modal.show()
  }
  else {
    // Disable the submit button
    submitButton.setAttribute("disabled", "");
    submitLoading.style.display = 'inline-flex';

    // Enable two-factor - Step 1/2
    if (twoFactorStep == 1) {
      try {
        const response = await fetch("https://api.retrox.app/profile/2fa", {
          method: "POST",
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: true
          })
        })

        const json = await response.json()
        if (!response.ok) {
          showAlert(twoFactorAlert, "danger", json['message'])
        }
        else {
          showAlert(twoFactorAlert, "success", json['message'])
          twoFactorStep = 2
          twoFactorDiv.style.display = 'block'
          twoFactorSubmitName.innerHTML = 'Submit'
          twoFactorCode.value = ''
          twoFactorCode.focus()
          QRCode.toCanvas(
            qrCanvas,
            json['2fa_uri'],
            { errorCorrectionLevel: "H" },
            function (error) {
              if (error) console.error(error);
              console.log("success!");
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
    else if (twoFactorStep == 2) {
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
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: true,
            code: twoFactorCode.value.trim()
          })
        })

        const json = await response.json()
        if (!response.ok) {
          showAlert(twoFactorAlert, "danger", json['message'])
        }
        else {
          showAlert(twoFactorAlert, "success", json['message'])
          twoFactorStep = 1
          twoFactorDiv.style.display = 'none'
          twoFactorSubmitName.innerHTML = 'Disable'
          twoFactorCode.value = ''
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
  const twoFactorSubmitName = document.getElementById('twoFactorSubmitName');
  const twoFactorAlert = document.getElementById("twoFactorAlert");
  const modalAlert = document.getElementById('modalAlert');
  const cancelModal = document.getElementById('cancelModal');

  // Disable 2FA
  try {
    const response = await fetch("https://api.retrox.app/profile/2fa", {
      method: "POST",
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enabled: false
      })
    })

    const json = await response.json()
    if (!response.ok) {
      showAlert(modalAlert, "danger", json['message'])
    }
    else {
      showAlert(twoFactorAlert, "success", json['message'])
      twoFactorSubmitName.innerHTML = 'Enable'
      localStorage.setItem('2fa', 'false')
      cancelModal.click()
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
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json',
      },
    })
    const json = await response.json()
    if (!response.ok) {
      showAlert(modalAlert, "danger", json['message'])
    }
    else {
      showAlert(modalAlert, "success", json['message'])

      // Perform the Logout request
      await fetch("https://api.retrox.app/logout/", { method: "POST" })

      // Clean local storage
      localStorage.removeItem('token')
      localStorage.removeItem('username')
      localStorage.removeItem('email')
      localStorage.removeItem('remember')

      setTimeout(() => {
        window.location.href = `${window.location.origin}`
      }, 1500)
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