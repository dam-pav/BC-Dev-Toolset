table 50203 "BCD Probe Sum Entry"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer)
        {
            AutoIncrement = true;
        }
        field(2; "Run ID"; Guid) { }
        field(3; "Header Line No."; Integer) { }
        field(4; Bucket; Integer) { }
        field(5; Amount; Decimal) { }
    }

    keys
    {
        key(PK; "Entry No.")
        {
            Clustered = true;
        }
        key(SumKey; "Run ID", "Header Line No.", Bucket)
        {
            SumIndexFields = Amount;
        }
    }
}
