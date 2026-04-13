const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";

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

function registrarSolicitacaoPendente({ nome, email, usuario, senha }, erroEl) {
  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === usuario.toLowerCase());
  const now = new Date().toISOString();

  const payload = {
    username: usuario,
    password: senha,
    name: nome,
    email,
    role: "pending",
    createdAt: users[idx]?.createdAt || now,
    approvedAt: null,
  };

  if (idx === -1) {
    users.push(payload);
  } else {
    users[idx] = { ...users[idx], ...payload };
  }

  saveStoredUsers(users);
  localStorage.removeItem(STORAGE_CURRENT_USER_KEY);

  erroEl.style.color = "#16a34a";
  erroEl.innerHTML = "✅ Solicitação enviada ao administrador. Aguarde a aprovação para acessar o portal.";
  document.querySelector(".btn-login").disabled = true;

  window.setTimeout(() => {
    window.location.href = "login.html";
  }, 1400);
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

  const useApi = window.location.protocol.startsWith("http");
  if (useApi) {
    const obs = document.getElementById("obs")?.value.trim() || "";
    fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nome, email, username: usuario, password: senha, obs }),
      credentials: "include",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Falha ao registrar");
        }

        registrarSolicitacaoPendente({
          nome,
          email,
          usuario,
          senha
        }, erroEl);
      })
      .catch((err) => {
        // fallback para localStorage em caso de erro de rede.
        const users = getStoredUsers();
        const existing = users.find(u => u.username.toLowerCase() === usuario.toLowerCase());
        if (existing) {
          erroEl.innerText = "❌ Usuário já existe. Tente outro.";
          return;
        }

        registrarSolicitacaoPendente({
          nome,
          email,
          usuario,
          senha
        }, erroEl);
      });

    return;
  }

  // Fallback local
  const users = getStoredUsers();
  const existing = users.find(u => u.username.toLowerCase() === usuario.toLowerCase());
  if (existing) {
    erroEl.innerText = "❌ Usuário já existe. Tente outro.";
    return;
  }

  registrarSolicitacaoPendente({
    nome,
    email,
    usuario,
    senha
  }, erroEl);
}
