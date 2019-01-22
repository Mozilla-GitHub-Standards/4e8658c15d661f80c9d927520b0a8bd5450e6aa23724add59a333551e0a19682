const assign = require('assign-deep')
const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Pit = require('./Pit-model.js')
const Group = require('./Group-model.js')
const User = require('./User-model.js')
const State = require('./State-model.js')
const ProcessGroup = require('../models/ProcessGroup-model.js')
const Process = require('../models/Process-model.js')
const Allocation = require('../models/Allocation-model.js')
const Utilization = require('../models/Utilization-model.js')

var Job = sequelize.define('job', {
    id:           { type: Sequelize.INTEGER, primaryKey: true },
    description:  { type: Sequelize.STRING,  allowNull: false },
    provisioning: { type: Sequelize.STRING,  allowNull: false },
    request:      { type: Sequelize.STRING,  allowNull: false },
    state:        { type: Sequelize.INTEGER, allowNull: true },
    rank:         { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    allocation:   { type: Sequelize.STRING,  allowNull: true },
    continues:    { type: Sequelize.INTEGER, allowNull: true }
})

Job.jobStates = {
    NEW: 0,
    PREPARING: 1,
    WAITING: 2,
    STARTING: 3,
    RUNNING: 4,
    STOPPING: 5,
    CLEANING: 6,
    DONE: 7
}

Job.hasMany(State)

Job.hasMany(ProcessGroup)

Job.belongsTo(Pit, { foreignKey: 'id' })

Job.belongsTo(User)

var JobGroup = Job.JobGroup = sequelize.define('jobgroup')
Job.belongsToMany(Group, { through: JobGroup })
Group.belongsToMany(Job, { through: JobGroup })

User.prototype.canAccessJob = async (job) => {
    if (this.admin || await job.hasUser(this)) {
        return true
    }
    return await job.hasOne({
        include: [
            {
                model: JobGroup,
                require: true,
                include: [
                    {
                        model: Group,
                        require: true,
                        include: [
                            {
                                model: User.UserGroup,
                                require: true,
                                include: [
                                    {
                                        model: User,
                                        require: true,
                                        where: { id: this.id }
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ]
    })
}

Job.getDir = (jobId) => Pit.getDir(jobId)
Job.prototype.getDir = function () {
    return Pit.getDir(this.id)
} 

Job.getDirExternal = (jobId) => Pit.getDirExternal(jobId)
Job.prototype.getDirExternal = function () {
    return Pit.getDirExternal(this.id)
}

Job.prototype.setState = async (state, reason) => {
    if (this.state == state) {
        return
    }
    let t
    try {
        t = await sequelize.transaction({ type: Sequelize.Transaction.TYPES.EXCLUSIVE })
        let stateData = { state: state, since: Date.now(), reason: reason }
        let stateEntry = await this.getState({ where: { state: state }, transaction: t, lock: t.LOCK })
        n = new State
        if (stateEntry) {
            stateEntry.since = Date.now()
            stateEntry.reason = reason
            stateEntry.update({ transaction: t, lock: t.LOCK })
        } else {
            await this.addState(stateData, { transaction: t, lock: t.LOCK })
        }
        if (this.state != Job.jobStates.WAITING && state == Job.jobStates.WAITING) {
            this.rank = ((await Job.max('rank', { where: { state: Job.jobStates.WAITING }, transaction: t, lock: t.LOCK })) || 0) + 1
        } else if (this.state == Job.jobStates.WAITING && state != Job.jobStates.WAITING) {
            await Job.update(
                { rank: Sequelize.literal('rank - 1') }, 
                { 
                    where: { 
                        state: Job.jobStates.WAITING, 
                        rank: { [gt]: this.rank } 
                    },
                    transaction: t, 
                    lock: t.LOCK
                }
            )
            this.rank = 0
        }
        this.state = state
        await this.save({ transaction: t, lock: t.LOCK })
        await t.commit()
    } catch (err) {
        await t.rollback()
        throw err
    }
}

Job.infoQuery = options => assign({
    include: [
        {
            model: State,
            require: true,
            attributes: [],
            where: { state: Sequelize.col('job.state') }
        },
        {
            model: ProcessGroup,
            require: false,
            attributes: [],
            include: [
                {
                    model: Process,
                    require: false,
                    attributes: [],
                    include: 
                    [
                        {
                            model: Allocation,
                            require: false,
                            attributes: [],
                            include: [
                                {
                                    model: Utilization,
                                    where: { type: 'compute' },
                                    as: 'compute',
                                    attributes: [],
                                    require: false
                                },
                                {
                                    model: Utilization,
                                    where: { type: 'memory' },
                                    as: 'memory',
                                    attributes: [],
                                    require: false
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    ],
    group: [
        'job.id'
    ],
    attributes: [
        [sequelize.fn('first', sequelize.col('state.since')),        'since'],
        [sequelize.fn('sum',   sequelize.col('compute.numsamples')), 'utilcomputecount'],
        [sequelize.fn('sum',   sequelize.col('compute.aggregated')), 'utilcompute'],
        [sequelize.fn('sum',   sequelize.col('memory.numsamples')),  'utilmemoryecount'],
        [sequelize.fn('sum',   sequelize.col('memory.aggregated')),  'utilmemory'],
        [sequelize.fn('avg',   sequelize.col('compute.current')),    'currentutilcompute'],
        [sequelize.fn('avg',   sequelize.col('memory.current')),     'currentutilmemory']
    ]
}, options)

module.exports = Job