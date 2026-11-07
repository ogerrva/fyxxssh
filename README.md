# ⚡ FYXXSSH — High-Speed SSH & SFTP Workspace Client

<p align="center">
  <img src="docs/logo.png" alt="FYXXSSH Logo" width="160" style="border-radius: 24px; box-shadow: 0 10px 30px rgba(168, 85, 247, 0.4);" />
</p>

<p align="center">
  <strong>O cliente SSH & SFTP moderno para Windows com navegação por atalhos de pastas remotas, drag & drop bidirecional e alta velocidade.</strong>
</p>

<p align="center">
  <a href="https://github.com/ogerrva/fyxxssh/releases/latest"><img src="https://img.shields.io/badge/Release-v1.0.4-purple?style=for-the-badge&logo=windows" alt="Release v1.0.4"></a>
  <a href="https://github.com/ogerrva/fyxxssh/releases/download/v1.0.4/FYXXSSH-Setup-v1.0.4.exe"><img src="https://img.shields.io/badge/Download-Instalador%20.EXE-blue?style=for-the-badge&logo=electron" alt="Download EXE"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License MIT"></a>
</p>

---

## 🚀 Baixar Agora

👉 **[Clique aqui para baixar o Instalador Oficial: FYXXSSH-Setup-v1.0.4.exe](https://github.com/ogerrva/fyxxssh/releases/download/v1.0.4/FYXXSSH-Setup-v1.0.4.exe)**

Também disponível a página web oficial: **[https://ogerrva.github.io/fyxxssh/](https://ogerrva.github.io/fyxxssh/)**

> **💡 Nota sobre o aviso do Windows Defender SmartScreen:**  
> Por se tratar de um aplicativo de código aberto e independente recém-compilado, o SmartScreen do Windows pode exibir um alerta preventivo no primeiro download.  
> Para prosseguir, basta clicar em **"Mais informações"** e em seguida **"Executar assim mesmo"**. O executável é 100% verificado, seguro e livre de qualquer ameaça.

---

## 🌟 O Diferencial do FYXXSSH

Nos clientes SSH tradicionais, ao conectar em um servidor como usuário `root`, a sessão sempre inicia presa na pasta `/root/`. Para quem gerencia múltiplos projetos, microserviços e sites na mesma VPS, isso exige navegar manualmente com `cd /opt/seu-projeto/` e localizar pastas repetidamente no SFTP.

O **FYXXSSH** resolve isso de forma definitiva:

1. **Atalhos Diretos de Pastas na Home**: Cadastre atalhos com caminhos específicos (ex: `/opt/fyxxdrops-web/` ou `/var/www/html/`). Ao clicar no atalho, tanto o **Terminal SSH interativo** quanto o **Explorador SFTP** abrem simultaneamente direto na pasta de destino!
2. **Captura Inteligente com 1 Clique**: Ao navegar pelo terminal ou SFTP, basta clicar no botão **"Salvar Atalho"** e o FYXXSSH detecta automaticamente a pasta de trabalho do shell remoto na VPS e nomeia o atalho para você.
3. **Arrastar e Soltar Bidirecional**: Arraste arquivos do Windows para a pasta do servidor e do servidor direto para a Área de Trabalho ou Explorer do Windows.
4. **Gestão Inteligente de Conflitos**: Detecção antecipada de arquivos repetidos, com opções de *Substituir*, *Criar Cópia numerada* ou *Pular*, além de checkbox *Aplicar a todos os arquivos*.
5. **Telemetria VPS em Tempo Real**: Barra superior com dados de CPU, Memória RAM, Uso de Disco e Uptime da VPS atualizados automaticamente.
6. **Zero Popups Nativos**: Todos os modais de confirmação, exclusão e edição foram desenhados artesanalmente no tema dark glass do programa.
7. **Single Instance Lock**: Proteção contra múltiplas instâncias concorrentes, eliminando conflitos de porta (`EADDRINUSE`).

---

## 🛠️ Tecnologias Utilizadas

- **Runtime**: Electron & Node.js
- **Terminal Engine**: xterm.js + WebLinks + Search Addon
- **SSH & SFTP Engine**: `ssh2` com otimização ChaCha20-Poly1305 e AES-128-GCM
- **Criptografia & Persistência**: `%APPDATA%\FYXXSSH\storage.json`
- **Instalador**: Inno Setup 6 (compressão LZMA2 de alta densidade)

---

## 💻 Como Rodar o Código Fonte Localmente

```bash
# 1. Clone o repositório
git clone https://github.com/ogerrva/fyxxssh.git
cd fyxxssh

# 2. Instale as dependências
npm install

# 3. Inicie em modo de desenvolvimento
npm start
```

### Compilar o Executável e o Instalador

```bash
# Compilar versão standalone portátil
npm run build:portable

# Compilar o instalador Windows Setup .exe
iscc.exe installer.iss
```

---

## 📄 Licença

Distribuído sob a licença **MIT**. Veja `LICENSE` para mais detalhes.

Desenvolvido por **[ogerrva](https://github.com/ogerrva)**.
