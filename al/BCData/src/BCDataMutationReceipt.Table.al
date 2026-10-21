table 99100 "BCD Mutation Receipt"
{
    Access = Internal;
    DataClassification = CustomerContent;
    // Company-local, principal-local request state. Never a business-table grant.
    fields
    {
        field(1; Principal; Guid) { }
        field(2; "Request ID"; Guid) { }
        field(3; Epoch; Guid) { }
        field(4; "Retry Until"; DateTime) { }
        field(5; Closed; Boolean) { }
        field(6; Completed; Boolean) { }
        field(7; Payload; Blob) { }
        field(8; Result; Blob) { }
        field(9; "Target ID"; Guid) { }
        field(10; "Table ID"; Integer) { }
        field(11; Operation; Text[10]) { }
        field(12; "Owner Session ID"; Integer) { }
    }
    keys
    {
        key(PK; Principal, "Request ID") { Clustered = true; }
        key(OwnedExpiry; Principal, "Retry Until") { }
    }
}
