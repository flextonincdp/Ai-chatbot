const btnRoleUser = document.getElementById('btnRoleUser');
const btnRoleAdmin = document.getElementById('btnRoleAdmin');
const formUser = document.getElementById('formUser');
const formAdmin = document.getElementById('formAdmin');
const userError = document.getElementById('userError');
const adminError = document.getElementById('adminError');
const btnUserSubmit = document.getElementById('btnUserSubmit');
const btnAdminSubmit = document.getElementById('btnAdminSubmit');

btnRoleUser.onclick = () => setRole('user');
btnRoleAdmin.onclick = () => setRole('admin');

function setRole(role) {
  btnRoleUser.classList.toggle('active', role === 'user');
  btnRoleAdmin.classList.toggle('active', role === 'admin');
  formUser.classList.toggle('active', role === 'user');
  formAdmin.classList.toggle('active', role === 'admin');
  userError.textContent = '';
  adminError.textContent = '';
}

async function doLogin(body, errorEl, submitBtn, btnText) {
  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span>Signing in...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    
    // Success - redirecting
    submitBtn.textContent = 'Redirecting...';
    window.location.href = data.redirect;
  } catch (e) {
    errorEl.textContent = e.message;
    submitBtn.disabled = false;
    submitBtn.textContent = btnText;
  }
}

formUser.onsubmit = (e) => {
  e.preventDefault();
  doLogin(
    { role: 'user', code: document.getElementById('userCode').value },
    userError,
    btnUserSubmit,
    'Enter chat'
  );
};

formAdmin.onsubmit = (e) => {
  e.preventDefault();
  doLogin(
    {
      role: 'admin',
      username: document.getElementById('adminUser').value,
      password: document.getElementById('adminPass').value
    },
    adminError,
    btnAdminSubmit,
    'Sign in to dashboard'
  );
};
