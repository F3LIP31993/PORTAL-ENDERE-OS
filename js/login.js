const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";

function initLogin() {
  // Local fallback para uso sem servidor.
  seedDefaultUsers();
}

function seedDefaultUsers() {
  const users = getStoredUsers();
  if (!users || users.length === 0) {
    const defaultAdmin = {
      username: "admin",
      password: "123",
      name: "Administrador",
      email: "admin@local",
      role: "admin",
      createdAt: new Date().toISOString(),
    };
    saveStoredUsers([defaultAdmin]);
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

function findUser(username) {
  if (!username) return null;
  const users = getStoredUsers();
  return users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function upsertStoredUser(user, password = "") {
  if (!user || !user.username) return;

  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === user.username.toLowerCase());
  const now = new Date().toISOString();
  const normalizedUser = {
    username: user.username,
    password: password || users[idx]?.password || user.password || "",
    name: user.name || users[idx]?.name || user.username,
    email: user.email || users[idx]?.email || "",
    role: user.role || users[idx]?.role || "viewer",
    createdAt: users[idx]?.createdAt || now,
    approvedAt: user.approvedAt || users[idx]?.approvedAt || now,
  };

  if (idx === -1) {
    users.push(normalizedUser);
  } else {
    users[idx] = { ...users[idx], ...normalizedUser };
  }

  saveStoredUsers(users);
}

function login(event) {
  event.preventDefault();

  const usuario = document.getElementById("usuario").value.trim();
  const senha = document.getElementById("senha").value.trim();
  const erroEl = document.getElementById("erro");
  const btnLogin = document.querySelector(".btn-login");

  erroEl.style.color = "#dc2626";
  erroEl.innerText = "";

  // Validações básicas
  if (!usuario || !senha) {
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

  // Desabilitar botão durante o login
  btnLogin.disabled = true;
  btnLogin.textContent = "Entrando...";

  const useApi = window.location.protocol.startsWith("http");

  if (useApi) {
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usuario, password: senha }),
      credentials: "include",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          // Erro HTTP do servidor — exibir mensagem diretamente, sem fallback local.
          erroEl.innerText = `❌ ${body.error || "Falha ao autenticar"}`;
          btnLogin.disabled = false;
          btnLogin.textContent = "Entrar";
          return;
        }

        const loggedUser = body?.user || {
          username: usuario,
          name: usuario,
          email: "",
          role: "viewer",
        };

        upsertStoredUser(loggedUser, senha);
        localStorage.setItem(STORAGE_CURRENT_USER_KEY, loggedUser.username || usuario);

        erroEl.style.color = "#16a34a";
        erroEl.innerText = "✅ Bem-vindo! Redirecionando...";
        if (loggedUser.must_change_password) {
          setTimeout(() => abrirModalTrocarSenha(loggedUser.username), 300);
          return;
        }
        setTimeout(() => {
          window.location.href = "dashboard.html";
        }, 600);
      })
      .catch(() => {
        // Apenas erros de rede chegam aqui (servidor inacessível) — fallback local.
        const user = findUser(usuario);
        if (!user) {
          erroEl.innerText = "❌ Usuário não encontrado. Cadastre-se para solicitar acesso.";
        } else if (user.role === "pending") {
          erroEl.innerText = "⏳ Sua solicitação está pendente de aprovação. Aguarde.";
        } else if (user.password !== senha) {
          erroEl.innerText = "❌ Usuário ou senha inválidos";
          document.getElementById("senha").value = "";
          document.getElementById("senha").focus();
        } else {
          localStorage.setItem(STORAGE_CURRENT_USER_KEY, user.username);
          erroEl.style.color = "#16a34a";
          erroEl.innerText = "✅ Bem-vindo! Redirecionando...";
          setTimeout(() => {
            window.location.href = "dashboard.html";
          }, 600);
        }
        btnLogin.disabled = false;
        btnLogin.textContent = "Entrar";
      });

    return;
  }

  // Fallback local (sem servidor)
  setTimeout(() => {
    const user = findUser(usuario);

    if (!user) {
      erroEl.innerText = "❌ Usuário não encontrado. Cadastre-se para solicitar acesso.";
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
      return;
    }

    if (user.role === "pending") {
      erroEl.innerText = "⏳ Sua solicitação está pendente de aprovação. Aguarde.";
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
      return;
    }

    if (user.password !== senha) {
      erroEl.innerText = "❌ Usuário ou senha inválidos";
      btnLogin.disabled = false;
      btnLogin.textContent = "Entrar";
      document.getElementById("senha").value = "";
      document.getElementById("senha").focus();
      return;
    }

    // Login bem-sucedido
    localStorage.setItem(STORAGE_CURRENT_USER_KEY, user.username);

    erroEl.style.color = "#16a34a";
    erroEl.innerText = "✅ Bem-vindo! Redirecionando...";

    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 600);
  }, 600);
}

document.addEventListener("DOMContentLoaded", initLogin);

// ===== MODAL TROCA DE SENHA (1º ACESSO) =====
function abrirModalTrocarSenha(username) {
  let modal = document.getElementById("modal-troca-senha");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-troca-senha";
    modal.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:14px;padding:36px 30px;width:100%;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,.22);">
          <h2 style="margin:0 0 6px;font-size:20px;color:#1e3a5f;">\ud83d\udd11 Defina sua senha</h2>
          <p style="margin:0 0 22px;font-size:13px;color:#64748b;">Este é seu primeiro acesso. Crie uma senha pessoal para continuar.</p>
          <div style="margin-bottom:14px;">
            <label style="font-size:13px;font-weight:600;color:#334155;">Nova senha</label>
            <input id="troca-senha-nova" type="password" placeholder="Mínimo 4 caracteres" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border:1.5px solid #cbd5e1;border-radius:8px;font-size:14px;" />
          </div>
          <div style="margin-bottom:22px;">
            <label style="font-size:13px;font-weight:600;color:#334155;">Confirmar senha</label>
            <input id="troca-senha-confirma" type="password" placeholder="Repita a nova senha" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border:1.5px solid #cbd5e1;border-radius:8px;font-size:14px;" />
          </div>
          <span id="troca-senha-erro" style="display:block;font-size:12px;color:#dc2626;min-height:16px;margin-bottom:12px;"></span>
          <button onclick="salvarTrocaSenha('${username}')" style="width:100%;padding:12px;background:#1d4ed8;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">Salvar nova senha</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  modal.style.display = "block";
}

async function salvarTrocaSenha(username) {
  const novaSenha = (document.getElementById("troca-senha-nova")?.value || "").trim();
  const confirma = (document.getElementById("troca-senha-confirma")?.value || "").trim();
  const erroEl = document.getElementById("troca-senha-erro");

  if (erroEl) erroEl.textContent = "";

  if (novaSenha.length < 4) {
    if (erroEl) erroEl.textContent = "\u26a0\ufe0f A senha deve ter ao menos 4 caracteres.";
    return;
  }

  if (novaSenha !== confirma) {
    if (erroEl) erroEl.textContent = "\u26a0\ufe0f As senhas n\u00e3o coincidem.";
    return;
  }

  try {
    if (window.location.protocol.startsWith("http")) {
      const res = await fetch("/api/change_password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: novaSenha })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (erroEl) erroEl.textContent = `\u26a0\ufe0f ${body.error || "Erro ao salvar senha."}`;
        return;
      }
    }

    // Atualiza localmente
    const users = getStoredUsers();
    const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (idx !== -1) {
      users[idx].password = novaSenha;
      users[idx].must_change_password = false;
      saveStoredUsers(users);
    }

    const modal = document.getElementById("modal-troca-senha");
    if (modal) modal.remove();

    window.location.href = "dashboard.html";
  } catch (err) {
    if (erroEl) erroEl.textContent = "\u26a0\ufe0f Erro de conex\u00e3o. Tente novamente.";
  }
}
