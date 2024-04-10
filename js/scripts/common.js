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

function googleDriveAuth(client_id, origin) {
  // Create a form to initiate the authentication
  var form = document.createElement('form');
  form.setAttribute('method', 'GET');
  form.setAttribute('action', 'https://accounts.google.com/o/oauth2/v2/auth');
  // form.setAttribute('target', '_blank');

  // Parameters to pass to OAuth 2.0 endpoint.
  var params = {
    'client_id': client_id,
    'redirect_uri': 'http://localhost:5500/callback.html', // 'https://www.retrox.app/callback',
    'scope': 'https://www.googleapis.com/auth/drive.file',
    'include_granted_scopes': 'true',
    'access_type': 'offline',
    'prompt': 'consent',
    'response_type': 'code',
    'state': origin,
  };

  // Add form parameters as hidden input values.
  for (var p in params) {
    var input = document.createElement('input');
    input.setAttribute('type', 'hidden');
    input.setAttribute('name', p);
    input.setAttribute('value', params[p]);
    form.appendChild(input);
  }

  // Add form to page and submit it to open the OAuth 2.0 endpoint.
  document.body.appendChild(form);
  form.submit();
}