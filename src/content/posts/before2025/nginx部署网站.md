---
title: 在Ubuntu上使用nginx部署静态网页
published: 2024-03-03
category: tools
tags: []
draft: false
---

1. 安装Nginx
首先，确保你的Ubuntu系统已经更新。打开终端并运行以下命令来更新你的包列表和安装Nginx：
```bash
sudo apt update
sudo apt install nginx
```
2. 进入到/etc/nginx/sites-available目录中
创建一个以.conf为后缀的新文件，或者找到default.conf。
在其中添加
```bash
server {
    listen 80;
    server_name mywebsite.com www.mywebsite.com;

    root /var/www/mywebsite;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```
4. 启用网站并重启Nginx
创建一个符号链接，将你的站点配置从sites-available目录链接到sites-enabled目录：
```bash
sudo ln -s /etc/nginx/sites-available/mywebsite /etc/nginx/sites-enabled/
```
检查Nginx配置文件是否有语法错误：
```bash
sudo nginx -t
```
如果没有问题，重启Nginx以应用更改：
```bash
sudo systemctl restart nginx
```

5. 访问你的网站
在浏览器中输入你配置的域名，你应该能够看到你的静态网站。   
如果你在本地机器上测试，可以直接访问http://localhost:80或http://127.0.0.1:80。
你部署在xx端口你就访问http://localhost:xx


![](./img/mynginx.png)
比如这是我的两个网页