// Custom symbol and hiding

Users.User.prototype.getIdentity = function(roomid) {
    if (this.locked) {
        return '‽' + this.name;
    }
    if (roomid) {
        if (this.mutedRooms[roomid]) {
            return '!' + this.name;
        }
        var room = Rooms.rooms[roomid];
        if (room && room.auth) {
            if (room.auth[this.userid]) {
                return room.auth[this.userid] + this.name;
            }
            if (room.isPrivate === true) return ' ' + this.name;
        }
    }
    if (this.hiding) {
      return ' ' + this.name;
    }
    if (this.customSymbol) {
        return this.customSymbol + this.name;
    }
    return this.group + this.name;
};

// Limit the number of concurrent connections a user can have.

var Connection = Users.Connection;
var User = Users.User;
var connections = Users.connections;
var connectedIps = Users.connectedIps = Object.create(null);

Users.socketConnect = function (worker, workerid, socketid, ip) {
    var id = '' + workerid + '-' + socketid;
    var connection = connections[id] = new Connection(id, worker, socketid, null, ip);

    if (!connectedIps[ip]) {
        connectedIps[ip] = 1;
    } else {
        connectedIps[ip]++;
    }

    if (!Config.connectionWhitelist) Config.connectionWhitelist = {};
    if (connectedIps[ip] > (Config.maxConnections || Infinity) && !Config.connectionWhitelist[ip] || connectedIps[ip] > Config.connectionWhitelist[ip]) {
        connection.send("|popup|You may not have more than " + (Config.connectionWhitelist[ip] || Config.maxConnections) + " concurrent connections.");
        return connection.destroy();
    }

    if (ResourceMonitor.countConnection(ip)) {
        connection.destroy();
        bannedIps[ip] = '#cflood';
        return;
    }
    var checkResult = Users.checkBanned(ip);
    if (!checkResult && Users.checkRangeBanned(ip)) {
        checkResult = '#ipban';
    }
    if (checkResult) {
        console.log('CONNECT BLOCKED - IP BANNED: ' + ip + ' (' + checkResult + ')');
        if (checkResult === '#ipban') {
            connection.send("|popup|Your IP (" + ip + ") is not allowed to connect to PS, because it has been used to spam, hack, or otherwise attack our server.||Make sure you are not using any proxies to connect to PS.");
        } else if (checkResult === '#cflood') {
            connection.send("|popup|PS is under heavy load and cannot accommodate your connection right now.");
        } else {
            connection.send("|popup|Your IP (" + ip + ") used is banned under the username '" + checkResult + "'. Your ban will expire in a few days.||" + (Config.appealurl ? " Or you can appeal at:\n" + Config.appealurl : ""));
        }
        return connection.destroy();
    }
    // Emergency mode connections logging
    if (Config.emergency) {
        fs.appendFile('logs/cons.emergency.log', '[' + ip + ']\n', function (err) {
            if (err) {
                console.log('!! Error in emergency conns log !!');
                throw err;
            }
        });
    }

    var user = new User(connection);
    connection.user = user;
    // Generate 1024-bit challenge string.
    require('crypto').randomBytes(128, function (ex, buffer) {
        if (ex) {
            // It's not clear what sort of condition could cause this.
            // For now, we'll basically assume it can't happen.
            console.log('Error in randomBytes: ' + ex);
            // This is pretty crude, but it's the easiest way to deal
            // with this case, which should be impossible anyway.
            user.disconnectAll();
        } else if (connection.user) {   // if user is still connected
            connection.challenge = buffer.toString('hex');
            // console.log('JOIN: ' + connection.user.name + ' [' + connection.challenge.substr(0, 15) + '] [' + socket.id + ']');
            var keyid = Config.loginserverpublickeyid || 0;
            connection.sendTo(null, '|challstr|' + keyid + '|' + connection.challenge);
        }
    });

    Dnsbl.reverse(ip, function (err, hosts) {
        if (hosts && hosts[0]) {
            user.latestHost = hosts[0];
            if (Config.hostfilter) Config.hostfilter(hosts[0], user, connection);
            if (user.named && !user.locked && user.group === Config.groupsranking[0]) {
                var shortHost = Users.shortenHost(hosts[0]);
                if (lockedRanges[shortHost]) {
                    user.send("|popup|You are locked because someone on your ISP has spammed, and your ISP does not give us any way to tell you apart from them.");
                    rangelockedUsers[shortHost][user.userid] = 1;
                    user.locked = '#range';
                    user.updateIdentity();
                }
            }
        } else {
            if (Config.hostfilter) Config.hostfilter('', user, connection);
        }
    });

    Dnsbl.query(connection.ip, function (isBlocked) {
        if (isBlocked) {
            connection.popup("You are locked because someone using your IP (" + connection.ip + ") has spammed/hacked other websites. This usually means you're using a proxy, in a country where other people commonly hack, or have a virus on your computer that's spamming websites.");
            if (connection.user && !connection.user.locked) {
                connection.user.locked = '#dnsbl';
                connection.user.updateIdentity();
            }
        }
    });

    user.joinRoom('global', connection);
};

Users.Connection.prototype.onDisconnect = function () {
    delete connections[this.id];
    connectedIps[this.ip]--;
    if (connectedIps[this.ip] == 0) delete connectedIps[this.ip];
    if (this.user) this.user.onDisconnect(this);
    this.user = null;
};
