'use strict'
var _ = require('lodash')
module.exports = function (options) {
  var seneca = this
  var plugin = 'docker-machine'
  seneca.depends('docker-machine', 'unix-command', 'docker')
  options = seneca.util.deepextend({
    driver: 'virtualbox',
    drivers: {
      digitalocean: {
        'region': 'lon1',
        'private-networking': true
      },
      amazonec2: {
        // 'access-key': Your access key id for the Amazon Web Services API.
        // 'secret-key': Your secret access key for the Amazon Web Services API.
        // 'session-token': Your session token for the Amazon Web Services API.
        // 'ami': The AMI ID of the instance to use.
        // 'region': The region to use when launching the instance.
        // 'vpc-id': Your VPC ID to launch the instance in.
        // 'zone': The AWS zone to launch the instance in (i.e. one of a,b,c,d,e).
        // 'subnet-id': AWS VPC subnet id.
        // 'security-group': AWS VPC security group name.
        // 'tags': AWS extra tag key-value pairs (comma-separated, e.g. key1,value1,key2,value2).
        // 'instance-type': The instance type to run.
        // 'device-name': The root device name of the instance.
        // 'root-size': The root disk size of the instance (in GB).
        // 'volume-type': The Amazon EBS volume type to be attached to the instance.
        // 'iam-instance-profile': The AWS IAM role name to be used as the instance profile.
        // 'ssh-user': The SSH Login username, which must match the default SSH user set in the ami used.
        // 'request-spot-instance': Use spot instances.
        // 'spot-price': Spot instance bid price (in dollars). Require the 'request-spot-instance flag.
        // 'use-private-address': Use the private IP address for docker-machine, but still create a public IP address.
        // 'private-address-only': Use the private IP address only.
        // 'monitoring': Enable CloudWatch Monitoring.
        // 'use-ebs-optimized-instance': Create an EBS Optimized Instance, instance type must support it.
        // 'ssh-keypath': Path to Private Key file to use for instance. Matching public key with .pub extension should exist
        // 'retries': Set retry count for recoverable failures (use -1 to disable)
      },
      google: {}
    },
    types: {
      master: {},
      slave: {}
    }
  }, options)

  function machine_name (machine) {
    return [options.driver, options.project, machine.type, machine.id].join('-')
  }
  seneca.add({
    role: plugin,
    cmd: 'machine-command',
    required$: ['command'],
    args: {
      object$: true
    },
    command: {
      string$: true
    },
    machine: {
      type: {
        string$: true
      },
      id: {
        notempty$: true
      }
    }
  }, function (msg, done) {
    var command = 'docker-machine ' + msg.command
    var args = msg.args
    var extra = msg.machine ? machine_name(msg.machine) : ''
    var opts = {}
    var docker = seneca.export('docker')
    if (docker.certs_dir) {
      opts.env = seneca.util.deepextend(msg.env, {
        MACHINE_TLS_CA_CERT: docker.certs_dir + "ca.pem",
        MACHINE_TLS_CA_KEY: docker.certs_dir + "ca_key.pem",
        MACHINE_TLS_CLIENT_CERT: docker.certs_dir + "cert.pem",
        MACHINE_TLS_CLIENT_KEY: docker.certs_dir + "key.pem"
      })
    }
    seneca.flow_act({
      role: 'unix-command',
      command: command,
      options: opts,
      args: args,
      extra: extra,
      format: msg.format
    }, done)
  })

  seneca.add({
    role: 'format',
    cmd: 'text-table',
    in: {
      string$: true
    },
    row: {
      string$: true
    },
    column: {
      string$: true
    }
  }, function (msg, done) {
    var column = msg.column || /\s+/
    var lines = msg.in.split(/\r\n|\r|\n/)
    if (!lines[0]) return done(null, [])
    if (!lines.length === 1) return done(null, [])
    var out = []
    var headers = lines[0].split(column)
    if (!headers.length) return done(null, [])
    for (var i = 1; i < lines.length; i++) {
      var lineArray = lines[i].split(column)
      var ob = {}
      var ii = 0
      var iii = 0
      while (ii < headers.length) {
        var item = lineArray[iii]
        if (item !== '*') {
          ob[headers[ii].toLowerCase()] = item
          ii++
        }
        iii++
      }
      out.push(ob)
    }
    done(null, out)
  })

  seneca.add({
    role: plugin,
    cmd: 'create'
  }, create)

  function create (msg, done) {
    msg.args = msg.args || {}
    var drivers = seneca.util.deepextend(options.drivers, options.types[msg.machine.type] || {}, msg.drivers || {})
    var args = {
      driver: msg.driver || options.driver
    }
    _.each(drivers[args.driver], function (value, key) {
      args[args.driver + '-' + key] = value
    })
    args = seneca.util.deepextend(args, msg.args)
    seneca.flow_act({
      role: plugin,
      cmd: 'machine-command',
      args: args,
      command: 'create',
      machine: msg.machine
    }, done)
  }
  seneca.add({
    role: plugin,
    cmd: 'create'
  }, amazonec2)

  function amazonec2 (msg, done) {
    var prior = this.prior
    msg.args = msg.args || {}
    var drivers = seneca.util.deepextend(options.drivers, options.types[msg.machine.type] || {}, msg.drivers || {})
    var driver = msg.driver || options.driver
    if (driver === 'amazonec2' && drivers.amazonec2['request-spot-instance']) {
      seneca.act({
        role: 'aws',
        cmd: 'cheapest-zone',
        InstanceTypes: [drivers.amazonec2['instance-type']]
      }, function (err, res) {
        if (err) done(err)
        _.set(msg, 'drivers.amazonec2.zone', res.zone)
        if (!drivers.amazonec2['spot-price']) _.set(msg, 'drivers.amazonec2.spot-price', parseFloat(res['spot-price']) + 0.0001)
        prior(msg, done)
      })
    }
    else {
      prior(msg, done)
    }
  }
  seneca.add({
    role: plugin,
    cmd: 'count'
  }, count)

  function count (msg, done) {
    seneca.act({
      role: plugin,
      cmd: 'list'
    }, function (err, res) {
      if (!res.length) return done(null, 0)
      var all = _.filter(res, {
        project: options.project,
        type: msg.type
      })
      done(err, all.length)
    })
  }
  seneca.add({
    role: plugin,
    cmd: 'list',
    filter: {
      string$: true
    },
    type: {
      string$: true
    }
  }, list)

  function list (msg, done) {
    var filter = msg.filter || `${options.project}${msg.type ? '-' + msg.type : ''}.`
    seneca.flow().wait({
      role: 'unix-command',
      command: 'docker-machine ls',
      args: {
        filter: `name=${filter}`,
        format: '\\{\\"name\\":\\"{{.Name}}\\",\\"url\\":\\"{{.URL}}\\",\\"state\\":\\"{{.State}}\\",\\"swarm\\":\\"{{.Swarm}}\\",\\"error\\":\\"{{.Error}}\\",\\"response\\":\\"{{.ResponseTime}}\\"\\}'
      }
    }).end(function (err, res) {
      if (err || !res) return done(null, [])
      var lines = res.split(/\r\n|\r|\n/)
      if (!lines[0]) lines = []
      for (var i = 0; i < lines.length; i++) {
        var line = JSON.parse(lines[i])
        var nameMeta = line.name.split('-')
        var ip = line.url ? _.split(line.url.substring(6), ':')[0] : ''
        lines[i] = _.extend(line, {
          driver: nameMeta[0],
          project: nameMeta[1],
          type: nameMeta[2],
          id: nameMeta[3],
          ip: ip
        })
      }
      done(err, lines)
    })
  }

  seneca.add({
    role: plugin,
    cmd: 'info',
    machine: {
      object$: true
    }
  }, info)

  function info (msg, done) {
    seneca.flow_act({
      role: plugin,
      cmd: 'list',
      filter: machine_name(msg.machine),
      out$: {
        _: 'get',
        args: '[0]'
      }
    }, done)
  }

  seneca.add({
    role: plugin,
    cmd: 'kill-all'
  }, function (msg, done) {
    seneca.flow_act({
      sequence: [{
        role: plugin,
        cmd: 'list',
        out$: [{
          _: 'map',
          args: 'name'
        }, {
          _: 'join',
          args: ' '
        }]
      }, {
        if$: '$.in && $.in.length',
        role: 'unix-command',
        command: 'docker-machine rm -f',
        $extra: '$.in'
      }]
    }, done)
  })
  seneca.add({
    role: plugin,
    cmd: 'logs',
    type: {
      required$: true
    },
    name: {
      string$: true
    }
  }, logs)

  function logs (msg, done) {
    seneca.flow_act({
      count: {
        role: plugin,
        cmd: 'count',
        type: msg.type
      },
      iterate$: {
        role: 'docker',
        command: 'logs',
        $machine: {
          type: msg.type,
          $id: '$.index'
        },
        extra: [msg.name]
      }
    }, done)
  }

  seneca.ready(function () {
    if (process.argv[2] === 'logs') {
      seneca.act({
        role: plugin,
        cmd: 'logs',
        type: process.argv[3],
        name: process.argv[4] || process.argv[3]
      })
    }
    if (process.argv[2] === 'list') {
      seneca.act({
        role: plugin,
        cmd: 'list',
        type: process.argv[3] || null
      }, console.log)
    }
    if (process.argv[2] === 'destroy') {
      seneca.act({
        role: plugin,
        cmd: 'kill-all'
      })
    }
  })


  return plugin
}
