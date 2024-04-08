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
  window.location.href = `${window.location.origin}/${page}.html`
}

async function checkLogin() {
  const expires = localStorage.getItem('expires')
  if (expires == null) return false
  if (expires < Date.now()) await logout('login')
}