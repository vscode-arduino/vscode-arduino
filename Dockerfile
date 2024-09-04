# get python version 3.8
FROM python:3.8.19-bookworm
# get nodejs version 20 in debian flavor
FROM node:20.17-bookworm


SHELL ["/bin/bash", "-c"]

# install utility packages
RUN apt update
RUN apt install -y openssh-server openssh-sftp-server bash sudo zsh net-tools vim git 
# install project tool dependancies
# RUN ls /usr/local/lib/node_modules/npm 1>&2 && exit 1
RUN npm install -g gulp node-gyp @vscode/vsce
RUN apt install -y g++-multilib build-essential libudev-dev

# SSHD configuration
EXPOSE 22/tcp
RUN mkdir /run/sshd
RUN mkdir -p /var/run/sshd


# Volume configuration
VOLUME ["/host_dir"]

# User configuration
RUN adduser --shell /bin/bash --home /home/ubuntu ubuntu
RUN usermod -aG sudo ubuntu
WORKDIR /home/ubuntu
USER ubuntu:ubuntu

# configure powerlevel10k
RUN git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ~/powerlevel10k
RUN echo 'source ~/powerlevel10k/powerlevel10k.zsh-theme' >>~/.zshrc

# copy the repository into the container
COPY --chown=ubuntu:ubuntu . /vscode-arduino

# clone arduino tools
RUN wget https://downloads.arduino.cc/arduino-1.8.19-linux64.tar.xz -P /home/ubuntu
RUN node /vscode-arduino/build/checkHash.js /home/ubuntu/arduino-1.8.19-linux64.tar.xz eb68bddc1d1c0120be2fca1350a03ee34531cf37f51847b21210b6e70545bc9b
RUN tar -xvf /home/ubuntu/arduino-1.8.19-linux64.tar.xz -C /home/ubuntu
USER root:root
RUN ln -s /home/ubuntu/arduino-1.8.19/arduino /usr/bin/arduino
USER ubuntu:ubuntu

# install npm dependencies
WORKDIR /vscode-arduino
RUN env CXX="g++" CC="gcc" 

USER root:root
WORKDIR /home/ubuntu
ENTRYPOINT ["/bin/zsh", "-c", "/usr/sbin/sshd && su ubuntu"]
