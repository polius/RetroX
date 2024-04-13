async function logout(page) {
  // Perform the Logout request
  await fetch("https://api.retrox.app/logout/", {
    method: "POST",
    credentials: 'include',
  })

  // Remove session variables and redirect to the home page
  localStorage.removeItem('token')
  localStorage.removeItem('email')
  localStorage.removeItem('2fa')
  localStorage.removeItem('expires')
  window.location.href = `${window.location.origin}/${page}.html`
}

async function checkLogin() {
  const expires = localStorage.getItem('expires')
  if (expires != null && expires + '000' < Date.now()) await logout('login')
}

function calculateSize(bytes) {
  if (bytes < 1024) return `${bytes} Bytes`
  if (bytes < 1024**2) return `${Math.round(bytes/1024).toFixed(2)} KB`
  if (bytes < 1024**3) return `${Math.round(bytes/1024/1024).toFixed(2)} MB`
  return `${Math.round(bytes/1024/1024/1024).toFixed(2)} GB`
}