import { RoomSchema, TermSchema } from '../../../db/schema';
import connectDB from '../../../lib/mongo';
import mongoose from 'mongoose';

class RoomsModel {
  constructor() {
    this.MODEL = null;
  }

  async initModel() {
    if (!this.MODEL) {
      await connectDB();
      this.MODEL = mongoose.models.Rooms || mongoose.model("Rooms", RoomSchema);
    }
    return this.MODEL;
  }

  async validateRoomData(roomData) {
    // Get active term
    const Term = mongoose.models.Term || mongoose.model('Term', TermSchema);
    const activeTerm = await Term.findOne({ status: 'Active' });
    if (!activeTerm) {
      throw new Error('No active term found');
    }
    roomData.academicYear = activeTerm.academicYear;

    // Continue with existing validation
  }

  async createRoom(roomData) {
    const Room = await this.initModel();
    const room = new Room({
      ...roomData,
      updateHistory: [{
        updatedBy: roomData.updatedBy,
        updatedAt: new Date(),
        action: 'created',
        academicYear: roomData.academicYear // Make sure academicYear is passed through
      }]
    });
    const savedRoom = await room.save();
    await savedRoom.populate('department', 'departmentCode departmentName');
    return JSON.parse(JSON.stringify(savedRoom));
  }

  async processRoomCreation(roomData) {
    // Get active term first
    const Term = mongoose.models.Term || mongoose.model('Term', TermSchema);
    const activeTerm = await Term.findOne({ status: 'Active' });
    if (!activeTerm) {
      throw new Error('No active term found');
    }
    roomData.academicYear = activeTerm.academicYear;

    // Check for existing active room
    const existingActive = await this.getRoomByCode(roomData.roomCode);
    if (existingActive) {
      throw new Error('Room code already exists');
    }

    // Check for inactive room
    const existingInactive = await this.getInactiveRoomByCode(roomData.roomCode);
    if (existingInactive) {
      return await this.reactivateRoom(roomData.roomCode, roomData.userId);
    }

    return await this.createRoom(roomData);
  }

  async getInactiveRoomByCode(roomCode) {
    const Room = await this.initModel();
    const room = await Room.findOne({ 
      roomCode, 
      isActive: false 
    });
    return room ? JSON.parse(JSON.stringify(room)) : null;
  }

  async reactivateRoom(roomCode, userId) {
    const Room = await this.initModel();
    const room = await Room.findOneAndUpdate(
      { roomCode, isActive: false },
      { 
        isActive: true,
        $push: {
          updateHistory: {
            updatedBy: userId,
            action: 'updated'
          }
        }
      },
      { new: true }
    ).populate('department', 'departmentCode departmentName');
    
    return room ? JSON.parse(JSON.stringify(room)) : null;
  }

  async getAllRooms() {
    try {
      const Room = await this.initModel();
      const rooms = await Room.aggregate([
        { $match: { isActive: true } },
        {
          $lookup: {
            from: 'departments',
            localField: 'department',
            foreignField: '_id',
            as: 'departmentInfo'
          }
        },
        { $unwind: { path: '$departmentInfo', preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            'department': {
              $cond: {
                if: { $ifNull: ['$departmentInfo', false] },
                then: {
                  _id: { $toString: '$departmentInfo._id' },
                  departmentCode: '$departmentInfo.departmentCode',
                  departmentName: '$departmentInfo.departmentName'
                },
                else: null
              }
            },
            '_id': { $toString: '$_id' },
            'updateHistory': {
              $map: {
                input: '$updateHistory',
                as: 'history',
                in: {
                  _id: { $toString: '$$history._id' },
                  updatedBy: { $toString: '$$history.updatedBy' },
                  updatedAt: { $dateToString: { date: '$$history.updatedAt', format: '%Y-%m-%dT%H:%M:%S.%LZ' } },
                  action: '$$history.action',
                  academicYear: '$$history.academicYear'
                }
              }
            },
            'createdAt': { $dateToString: { date: '$createdAt', format: '%Y-%m-%dT%H:%M:%S.%LZ' } },
            'updatedAt': { $dateToString: { date: '$updatedAt', format: '%Y-%m-%dT%H:%M:%S.%LZ' } }
          }
        }
      ]);

      return rooms;
    } catch (error) {
      console.error('Error in getAllRooms:', error);
      throw error;
    }
  }

  async getRoomByCode(roomCode) {
    const Room = await this.initModel();
    const room = await Room.findOne({ roomCode, isActive: true })
      .populate('department', 'departmentCode departmentName')
      .populate('updateHistory.updatedBy', 'firstName lastName');
    return room ? JSON.parse(JSON.stringify(room)) : null;
  }

  async updateRoom(roomCode, updateData) {
    const Room = await this.initModel();
    
    // Handle both FormData and regular objects
    let updateHistory;
    let plainUpdateData = {};

    if (updateData instanceof FormData) {
      // Handle FormData
      if (updateData.get('$push[updateHistory]')) {
        updateHistory = JSON.parse(updateData.get('$push[updateHistory]'));
      }
      
      // Convert FormData to plain object
      updateData.forEach((value, key) => {
        if (key !== 'userId' && key !== '$push[updateHistory]') {
          plainUpdateData[key] = value;
        }
      });
    } else {
      // Handle regular object
      if (updateData.$push?.updateHistory) {
        updateHistory = updateData.$push.updateHistory;
        delete updateData.$push;
      }
      plainUpdateData = { ...updateData };
    }

    const room = await Room.findOneAndUpdate(
      { roomCode, isActive: true },
      {
        $set: plainUpdateData,
        ...(updateHistory && { $push: { updateHistory } })
      },
      { new: true, runValidators: true }
    ).populate('department', 'departmentCode departmentName');
    
    return room ? JSON.parse(JSON.stringify(room)) : null;
  }

  async processRoomUpdate(roomCode, updateData) {
    const updatedRoom = await this.updateRoom(roomCode, updateData);
    if (!updatedRoom) {
      throw new Error('Room not found');
    }
    return updatedRoom;
  }

  async deleteRoom(roomCode, updateData) {
    const Room = await this.initModel();
    const { $push, academicYear, ...otherUpdateData } = updateData;
    
    const room = await Room.findOneAndUpdate(
      { roomCode, isActive: true },
      { 
        $set: { ...otherUpdateData, isActive: false },
        $push: {
          ...updateData.$push,
          'updateHistory.$.academicYear': academicYear
        }
      },
      { new: true }
    );
    return room ? JSON.parse(JSON.stringify(room)) : null;
  }

  async processRoomDeletion(roomCode, userId) {
    // Get active term
    const Term = mongoose.models.Term || mongoose.model('Term', TermSchema);
    const activeTerm = await Term.findOne({ status: 'Active' });
    if (!activeTerm) {
      throw new Error('No active term found');
    }

    const updateData = {
      updatedBy: userId,
      $push: {
        updateHistory: {
          updatedBy: userId,
          updatedAt: new Date(),
          action: 'deleted',
          academicYear: activeTerm.academicYear
        }
      }
    };

    const deletedRoom = await this.deleteRoom(roomCode, updateData);
    if (!deletedRoom) {
      throw new Error('Failed to delete room');
    }
    return deletedRoom;
  }

  async getRoomsByDepartment(departmentId = null) {
    try {
      const Room = await this.initModel();
      const query = { 
        isActive: true,
        $or: [
          { department: departmentId ? new mongoose.Types.ObjectId(departmentId) : null },
          { department: { $exists: false } },
          { department: null }
        ]
      };

      const rooms = await Room.find(query)
        .populate({
          path: 'department',
          select: 'departmentCode departmentName',
          model: 'Departments'
        })
        .sort({ roomCode: 1 });
      
      // Convert to plain objects with proper date handling
      const plainRooms = rooms.map(room => {
        const plainRoom = room.toObject();
        if (plainRoom.updateHistory) {
          plainRoom.updateHistory = plainRoom.updateHistory.map(history => ({
            ...history,
            updatedAt: history.updatedAt instanceof Date ? history.updatedAt : new Date(history.updatedAt)
          }));
        }
        return plainRoom;
      });

      console.log(`Found ${rooms.length} rooms for department ${departmentId}`);
      return plainRooms;
    } catch (error) {
      console.error('Error in getRoomsByDepartment:', error);
      throw error;
    }
  }

  static async getRooms() {
    try {
      const rooms = await Rooms.aggregate([
        { $match: { isActive: true } },
        {
          $lookup: {
            from: 'departments',
            localField: 'department',
            foreignField: '_id',
            as: 'departmentInfo'
          }
        },
        { $unwind: { path: '$departmentInfo', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: { $toString: '$_id' },
            roomCode: 1,
            roomName: 1,
            capacity: 1,
            type: 1,
            floor: 1,
            department: {
              $cond: {
                if: { $ifNull: ['$departmentInfo', false] },
                then: {
                  _id: { $toString: '$departmentInfo._id' },
                  departmentCode: '$departmentInfo.departmentCode',
                  departmentName: '$departmentInfo.departmentName'
                },
                else: null
              }
            },
            updateHistory: {
              $map: {
                input: '$updateHistory',
                as: 'history',
                in: {
                  _id: { $toString: '$$history._id' },
                  updatedBy: { $toString: '$$history.updatedBy' },
                  updatedAt: '$$history.updatedAt',
                  action: '$$history.action',
                  academicYear: '$$history.academicYear'
                }
              }
            },
            createdAt: 1,
            updatedAt: 1
          }
        },
        { $sort: { roomCode: 1 } }
      ]);

      // Parse dates and ensure all objects are plain
      const serializedRooms = rooms.map(room => ({
        ...room,
        createdAt: room.createdAt?.toISOString(),
        updatedAt: room.updatedAt?.toISOString(),
        updateHistory: room.updateHistory?.map(history => ({
          ...history,
          updatedAt: history.updatedAt?.toISOString()
        }))
      }));

      return serializedRooms;
    } catch (error) {
      console.error('Rooms fetch error:', error);
      throw new Error('Failed to fetch rooms');
    }
  }
}

const roomsModel = new RoomsModel();
export default roomsModel;
