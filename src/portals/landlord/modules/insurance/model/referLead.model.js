const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ReferLeadSchema = new Schema(
  {
    user_id:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
    landlord_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // What we sent to Steadily
    request: { type: Schema.Types.Mixed, required: true },

    // Raw response from Steadily
    response: { type: Schema.Types.Mixed, default: null },

    // Parsed key fields for quick access
    external_record_id: { type: String, default: null },
    start_url:          { type: String, default: null },

    status:         { type: String, enum: ['success', 'failed'], default: 'success' },
    steadily_error: { type: String, default: null },
  },
  { timestamps: true }
);

ReferLeadSchema.index({ landlord_id: 1, createdAt: -1 });

module.exports =
  mongoose.models.ReferLead || mongoose.model('ReferLead', ReferLeadSchema);
