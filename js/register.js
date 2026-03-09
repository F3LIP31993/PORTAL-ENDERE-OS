const STORAGE_USERS_KEY = "portalUsers";

seedDefaultUsers();

function seedDefaultUsers() {
  const users = getStoredUsers();
  if (!users || users.length === 0) {
    users.push({
      username: "admin",
      password: "123",
      name: "Administrador",
      email: "admin@local",
      role: "admin",
      createdAt: new Date().toISOString(),
    });
    saveStoredUsers(users);
  }
}

function getStoredUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStoredUsers(users) {
  localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(users || []));
}

function register(event) {
  event.preventDefault();

  const nome = document.getElementById("nome").value.trim();
  const email = document.getElementById("email").value.trim();
  const usuario = document.getElementById("usuario").value.trim();
  const senha = document.getElementById("senha").value.trim();
  const confirmSenha = document.getElementById("confirmSenha").value.trim();
  const erroEl = document.getElementById("erro");

  erroEl.style.color = "#dc2626";
  erroEl.innerText = "";

  if (!nome || !email || !usuario || !senha || !confirmSenha) {
    erroEl.innerText = "⚠️ Preencha todos os campos";
    return;
  }

  if (usuario.length < 3) {
    erroEl.innerText = "⚠️ Usuário deve ter pelo menos 3 caracteres";
    return;
  }

  if (senha.length < 3) {
    erroEl.innerText = "⚠️ Senha deve ter pelo menos 3 caracteres";
    return;
  }

  if (senha !== confirmSenha) {
    erroEl.innerText = "⚠️ As senhas não coincidem";
    return;
  }

  const users = getStoredUsers();
  const existing = users.find(u => u.username.toLowerCase() === usuario.toLowerCase());
  if (existing) {
    erroEl.innerText = "❌ Usuário já existe. Tente outro.";
    return;
  }

  users.push({
    username: usuario,
    password: senha,
    name: nome,
    email: email,
    role: "pending",
    createdAt: new Date().toISOString(),
  });
  saveStoredUsers(users);

  erroEl.style.color = "#16a34a";
  erroEl.innerText = "✅ Solicitação enviada! Aguarde aprovação.";
  document.querySelector(".btn-login").disabled = true;

  setTimeout(() => {
    window.location.href = "login.html";
  }, 2000);
}
