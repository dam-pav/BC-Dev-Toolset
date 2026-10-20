table 50222 "BCD Mutation Trigger Log"
{
    DataClassification = CustomerContent;
    fields
    {
        field(1; "Event ID"; Guid) { }
        field(2; "Run ID"; Guid) { }
        field(3; Action; Code[1]) { }
    }
    keys { key(PK; "Event ID") { Clustered = true; } }
}
