# Publicação do Portal de Endereços

## 🌍 Publicação pública completa (GitHub Pages + Render)

Se o frontend já está no GitHub Pages (`https://f3lip31993.github.io/PORTAL-ENDERE-OS/`), publique o backend no **Render**:

### 1) Arquivos já preparados neste projeto
- `render.yaml` → blueprint pronto para subir no Render
- `Procfile` → comando de inicialização com `gunicorn`
- `js/api-config.js` → permite o frontend estático usar o backend publicado
- `app.py` → agora respeita `PORT`, `DATABASE_URL`, CORS e cookies seguros

### 2) Como subir no Render
1. Envie este projeto para o GitHub
2. No Render, clique em **New +** → **Blueprint**
3. Selecione o repositório
4. Confirme a criação do serviço web + banco PostgreSQL
5. Aguarde o deploy finalizar

### 3) Como conectar o GitHub Pages ao backend
Depois do deploy, abra uma vez o portal com o parâmetro `?api=`:

```text
https://f3lip31993.github.io/PORTAL-ENDERE-OS/login.html?api=https://SEU-BACKEND.onrender.com
```

Isso grava o endereço do backend no navegador e o login/dashboard passam a usar a API publicada automaticamente.

> Se preferir, também é possível preencher manualmente a meta tag `portal-api-base` nos arquivos HTML.

---

## 🚀 Modo Read-Only (Apenas Visualização)

Para publicar o portal em modo **read-only** (apenas visualização, sem permissão para editar):

### Opção 1: Usando o script de publicação

```bash
python publish.py --mode readonly
```

Isso vai:
- Gerar um token aleatório para compartilhamento
- Criar arquivo `.env` com as configurações
- Exibir a URL e token para compartilhamento

### Opção 2: Com token específico

```bash
python publish.py --mode readonly --token MEU_TOKEN_123
```

### Opção 3: Manualmente

Edite ou crie o arquivo `.env`:

```env
READ_ONLY_MODE=true
READ_ONLY_SHARED_TOKEN=MEU_TOKEN_123
```

## 🔗 Acessar o Portal

### Em modo Read-Only:
- **URL:** `http://localhost:5000` (ou seu IP/domínio)
- **Token:** Será exibido ao iniciar ou no arquivo `.env`
- **Permissões:** Apenas visualização - sem editar, importar ou excluir

### Em modo Normal:
- **URL:** `http://localhost:5000/login.html`
- **Usuário:** admin
- **Senha:** (conforme configurado)

## 📊 Recursos em Modo Read-Only

**HABILITADOS:**
- ✅ Ver todos os cartões (PROJETO F, EMPRESARIAL, ONGOING, etc)
- ✅ Filtrar dados
- ✅ Pesquisar
- ✅ Visualizar detalhes
- ✅ Visualizar observações existentes

**DESABILITADOS:**
- ❌ Importar CSVs
- ❌ Adicionar novas observações
- ❌ Editar registros
- ❌ Excluir registros
- ❌ Anexar arquivos

## 🌐 Compartilhamento

### Para compartilhar com outros:

1. **Gere um token:**
   ```bash
   python publish.py --generate-token
   ```

2. **Compartilhe a URL:**
   - Copie o link: `http://<seu-ip>:5000?token=SEU_TOKEN`
   - Envie para o destinatário
   - Não é necessário login - acesso direto ao portal em read-only

### Via ngrok (para compartilhar pela internet):

```bash
pip install ngrok
ngrok http 5000
```

Isso vai gerar uma URL pública (ex: `https://abc123.ngrok.io`) que você pode compartilhar.

## ⚙️ Iniciar o Servidor

### Modo read-only (configurado via `publish.py`):
```bash
python publish.py --mode readonly
# Depois:
python app.py
```

### Modo normal (com autenticação):
```bash
python publish.py --mode server
# Depois:
python app.py
```

### Para sua máquina apenas:
```bash
python app.py
# Acessa: http://localhost:5000
```

### Para rede local (outro computador):
```bash
python app.py
# Outro computador acessa: http://<seu-ip>:5000
```

## 🔒 Segurança

### Modo Read-Only:
- Dados são acessíveis mas **não podem ser modificados**
- Sem autenticação necessária (acesso direto via link)
- Ideal para compartilhamento seguro

### Modo Normal:
- Requer login com credenciais
- Acesso completo após autenticação
- Histórico de modificações registrado

## 🛠️ Troubleshooting

### Portal não acessível de outra máquina?
- Verifique se o firewall permite porta 5000
- Tente o IP local em vez de localhost
- Verificar com: `ipconfig` (Windows) ou `ifconfig` (Linux/Mac)

### Erro de permissão ao importar em modo read-only?
- Isto é esperado! Em modo read-only, essas operações estão desabilitadas
- Mude o portal para modo normal se precisar importar

### Token expirado?
- Gere um novo token: `python publish.py --generate-token`
- Reinicie o servidor

## 📝 Exemplos de Uso

### Cenário 1: Apresentação executiva
```bash
python publish.py --mode readonly --port 5001
python app.py
# Compartilhe o link - não há risco de alterações
```

### Cenário 2: Ambiente de homologação
```bash
python publish.py --mode server --port 5000
python app.py
# Equipe interna com login pode fazer alterações
```

### Cenário 3: Auditoria / Documentação
```bash
python publish.py --mode readonly --token AUDITORIA_2024
python app.py
# Link imutável para fins de conformidade
```

## 📞 Suporte

Para mais informações ou problemas, consulte:
- README.md - Documentação geral
- app.py - Configurações do servidor
- dashboard.html - Interface web
