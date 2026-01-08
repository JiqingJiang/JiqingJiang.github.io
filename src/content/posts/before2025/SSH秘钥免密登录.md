---
title: 设置SSH秘钥免密码登录服务器
published: 2023-11-22 
tags: []
category: tools
draft: false
---
当你需要设置SSH密钥以进行远程访问时，以下是从生成SSH密钥对到将公钥添加到远程服务器的完整步骤，以及每一步的解释：
### 1. 生成SSH密钥对
1. 打开终端（Linux或Mac）或使用Git Bash（Windows）。
2. 在终端中运行以下命令来生成SSH密钥对：
    ```bash
    ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
    ```
    - `ssh-keygen`: 生成SSH密钥对的命令。
    - `-t rsa`: 指定生成RSA类型的密钥。
    - `-b 4096`: 指定密钥长度为4096位，这是一种更安全的长度。
    - `-C "your_email@example.com"`: 提供一个注释，一般是你的电子邮件地址。
3. 按照提示，选择密钥文件的保存路径和设置密码（可选）。
    这里一直enter就可以。
### 2. 将公钥添加到远程服务器
1. 使用以下命令将公钥复制到远程服务器（确保将 `your_email@example.com` 替换为你的电子邮件地址）：
    ```bash
    ssh-copy-id username@remote_host
    ```
    - `ssh-copy-id`: 一个用于将本地公钥复制到远程主机的命令。
    - `username`: 远程服务器上你要登录的用户名。
    - `remote_host`: 目标服务器的IP地址或域名。
    这里第一次使用ssh-copy-id username@remote_host，需要输入username@remote_host的密码。
2. 如果 `ssh-copy-id` 命令不可用，你可以手动复制公钥内容并登录到远程服务器，然后将其添加到 `~/.ssh/authorized_keys` 文件中：
    ```bash
    mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "PASTE_YOUR_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
    ```
    - `PASTE_YOUR_PUBLIC_KEY_HERE`: 将你的公钥内容粘贴到这里。
### 3. SSH连接
1. 使用以下命令通过SSH连接到远程服务器：
    ```bash
    ssh username@remote_host
    ```  
    - `username`: 远程服务器上你的用户名。
    - `remote_host`: 远程服务器的IP地址或域名。
2. 如果设置了私钥密码，系统会要求输入私钥密码。如果一切设置正确，你将能够无需密码直接连接到远程服务器。
