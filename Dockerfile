FROM ubuntu:23.10

# # set timezone ?
RUN ln -snf /usr/share/zoneinfo/Etc/Universal /etc/localtime 

# install utility packages
RUN apt update
RUN apt install -y openssh-server openssh-sftp-server bash sudo zsh net-tools vim git python3.11 curl wget
SHELL ["/bin/bash", "-c"]

# install node js
ENV NVM_DIR=/usr/local/nvm
ENV NODE_VERSION=18.20.4
RUN mkdir -p $NVM_DIR && export NVM_DIR=$NVM_DIR && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash 
RUN source $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default
ENV NODE_PATH=$NVM_DIR/v$NODE_VERSION/lib/node_modules
ENV PATH=$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH


# install project tool dependancies
RUN npm install -g gulp node-gyp @vscode/vsce
RUN apt install -y g++-multilib build-essential libudev-dev unzip

# SSHD configuration
EXPOSE 22/tcp
RUN mkdir -p /var/run/sshd


# Volume configuration
VOLUME ["/host_dir"]

# User configuration
RUN usermod --shell /bin/bash -aG sudo ubuntu
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
ENV CXX="g++" 
ENV CC="gcc" 
RUN npm install

WORKDIR /home/ubuntu
USER root:root
RUN cat ~/.bashrc >> .bashrc
RUN echo "export NODE_PATH=$NVM_DIR/v$NODE_VERSION/lib/node_modules" >> .bashrc
RUN echo "export PATH=$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH" >> .bashrc
RUN echo "export NODE_OPTIONS=\"--openssl-legacy-provider --no-experimental-fetch\"" >> .bashrc
RUN echo "source $NVM_DIR/nvm.sh" >> .bashrc
RUN cat .bashrc >> .zshrc
ENTRYPOINT ["/bin/bash", "-c", "/usr/sbin/sshd && su ubuntu"]
