async function logout() {
  // Perform the Logout request
  await fetch("https://api.retrox.app/logout/", {
    method: "POST",
    credentials: 'include',
  })

  // Remove session variables and redirect to the home page
  localStorage.removeItem('token')
  localStorage.removeItem('2fa')
  localStorage.removeItem('expires')
  localStorage.removeItem('google_client_id')

  // Open new page if user was playing
  if (window.location.pathname.startsWith('/play')) {
    window.open(`${window.location.origin}/login${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`, '_blank');
  }
  else window.location.href = `${window.location.origin}/login${window.location.hostname === 'www.retrox.app' ? '' : '.html'}`
}

function isLogged() {
  const expires = localStorage.getItem('expires')
  if (expires != null && expires + '000' < Date.now()) return false
  return true
}

function calculateSize(bytes) {
  if (bytes < 1024) return `${bytes} Bytes`
  if (bytes < 1024**2) return `${Math.round(bytes/1024).toFixed(2)} KB`
  if (bytes < 1024**3) return `${Math.round(bytes/1024/1024).toFixed(2)} MB`
  return `${Math.round(bytes/1024/1024/1024).toFixed(2)} GB`
}

function resize() {
  var width = window.innerWidth;
  var logoutButton = document.getElementById('logoutButton');

  if (width <= 600) {
    // Switch to icon
    if (logoutButton) {
      logoutButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" class="bi bi-box-arrow-right" viewBox="0 0 16 16" style="margin-bottom:2px">
          <path fill-rule="evenodd" d="M10 12.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v2a.5.5 0 0 0 1 0v-2A1.5 1.5 0 0 0 9.5 2h-8A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-2a.5.5 0 0 0-1 0z"/>
          <path fill-rule="evenodd" d="M15.854 8.354a.5.5 0 0 0 0-.708l-3-3a.5.5 0 0 0-.708.708L14.293 7.5H5.5a.5.5 0 0 0 0 1h8.793l-2.147 2.146a.5.5 0 0 0 .708.708z"/>
        </svg>`
      logoutButton.setAttribute('title', 'Logout')
    }
  }
  else {
    // Switch back to text
    if (logoutButton) {
      logoutButton.innerHTML = 'Logout'
      logoutButton.removeAttribute('title')
    }
  }
}

resize()
window.addEventListener('resize', resize);